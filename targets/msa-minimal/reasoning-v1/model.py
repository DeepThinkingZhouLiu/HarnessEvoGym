"""通过 Controller 隔离网关调用 OpenAI Chat Completions。

保留 MSA 上游 Agent 的 query(socket_path, api_key, messages, max_tokens)
接口，但第一个参数由 run.py 注入为 Run 专属的内网 HTTP 地址。
"""

from __future__ import annotations

import http.client
import json
import os
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
    if "text/event-stream" not in response.headers.get("content-type", "").lower():
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


def _positive_environment(name: str) -> int:
    value = int(os.environ[name])
    if value < 1:
        raise RuntimeError(f"{name} must be positive")
    return value


def query(
    socket_path: str,
    api_key: str,
    messages: list[dict],
    max_output_tokens: int,
) -> str:
    parsed = urlsplit(socket_path)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("model gateway URL must be an internal HTTP endpoint")
    endpoint = f"{parsed.path.rstrip('/')}/chat/completions" or "/chat/completions"
    controller_limit = _positive_environment("RSI_MODEL_GATEWAY_MAX_TOKENS")
    body = json.dumps({
        "model": os.environ["RSI_MODEL_GATEWAY_MODEL"],
        "messages": messages,
        "max_tokens": min(int(max_output_tokens), controller_limit),
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
        answer = _read_response(response).strip()
    finally:
        connection.close()
    if not answer:
        raise RuntimeError("model gateway returned no text")
    return answer
