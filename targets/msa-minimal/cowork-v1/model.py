"""通过 Controller 隔离网关调用 OpenAI Chat Completions。"""

from __future__ import annotations

import http.client
import json
from urllib.parse import urlsplit


def _content(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


def _read_response(response: http.client.HTTPResponse) -> str:
    raw = response.read().decode("utf-8", errors="replace")
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        payload = json.loads(raw)
        choices = payload.get("choices", [])
        return _content(choices[0].get("message", {}).get("content")) if choices else ""

    parts: list[str] = []
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        choices = event.get("choices", [])
        if choices:
            parts.append(_content(choices[0].get("delta", {}).get("content")))
    return "".join(parts)


def query(
    gateway_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_output_tokens: int,
) -> str:
    parsed = urlsplit(gateway_url)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("model gateway URL must be an internal HTTP endpoint")
    base_path = parsed.path.rstrip("/")
    endpoint = f"{base_path}/chat/completions" or "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode("utf-8")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=1200)
    connection.request(
        "POST",
        endpoint,
        body=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )
    response = connection.getresponse()
    try:
        if response.status != 200:
            error = response.read(4096).decode("utf-8", errors="replace")
            raise RuntimeError(f"model gateway HTTP {response.status}: {error}")
        text = _read_response(response).strip()
    finally:
        connection.close()
    if not text:
        raise RuntimeError("model gateway returned no text")
    return text
