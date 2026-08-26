"""Tiny OpenAI Responses client over the Controller's Unix socket."""

from __future__ import annotations

import http.client
import json
import socket


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: int = 900):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def _output_text(response: dict) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    parts: list[str] = []
    for item in response.get("output", []):
        for content in item.get("content", []):
            if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                parts.append(content["text"])
    return "".join(parts)


def _read_sse(raw: str) -> str:
    deltas: list[str] = []
    completed: dict | None = None
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        if event.get("type") == "response.output_text.delta":
            deltas.append(event.get("delta", ""))
        elif event.get("type") == "response.output_text.done" and not deltas:
            deltas.append(event.get("text", ""))
        elif event.get("type") == "response.completed":
            completed = event.get("response")
        elif event.get("type") in {"error", "response.failed"}:
            raise RuntimeError(json.dumps(event, ensure_ascii=False))
    text = "".join(deltas)
    return text or (_output_text(completed) if completed else "")


def query(socket_path: str, api_key: str, messages: list[dict], max_output_tokens: int) -> str:
    body = json.dumps({
        "model": "controller-selected",
        "input": messages,
        "max_output_tokens": max_output_tokens,
        "stream": True,
    }).encode()
    connection = UnixHTTPConnection(socket_path)
    connection.request(
        "POST",
        "/v1/responses",
        body=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        },
    )
    response = connection.getresponse()
    raw = response.read().decode("utf-8", errors="replace")
    connection.close()
    if response.status != 200:
        raise RuntimeError(f"model gateway HTTP {response.status}: {raw[:1000]}")
    text = _read_sse(raw).strip()
    if not text:
        raise RuntimeError("model gateway returned no text")
    return text
