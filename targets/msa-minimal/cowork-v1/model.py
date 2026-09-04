"""通过 Controller 隔离网关调用 OpenAI Chat Completions。"""

from __future__ import annotations

import http.client
import json
from urllib.parse import urlsplit

MAXIMUM_EMPTY_RESPONSE_ATTEMPTS = 3


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


def _response_result(
    text: str,
    finish_reason: str | None,
    saw_reasoning: bool,
    refused: bool,
) -> dict:
    return {
        "text": text,
        "finish_reason": finish_reason,
        "saw_reasoning": saw_reasoning,
        "refused": refused,
    }


def _read_response(response: http.client.HTTPResponse) -> dict:
    raw = response.read().decode("utf-8", errors="replace")
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        payload = json.loads(raw)
        choices = payload.get("choices", [])
        if not choices or not isinstance(choices[0], dict):
            return _response_result("", None, False, False)
        choice = choices[0]
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        finish_reason = choice.get("finish_reason")
        if not isinstance(finish_reason, str):
            finish_reason = None
        return _response_result(
            _content(message.get("content")),
            finish_reason,
            bool(_content(message.get("reasoning_content")).strip()),
            bool(_content(message.get("refusal")).strip()),
        )

    parts: list[str] = []
    final_message = ""
    finish_reason: str | None = None
    saw_reasoning = False
    refused = False
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        if event.get("error") is not None:
            raise RuntimeError("model gateway streamed an upstream error")
        choices = event.get("choices", [])
        if not choices or not isinstance(choices[0], dict):
            continue
        choice = choices[0]
        delta = choice.get("delta", {})
        if not isinstance(delta, dict):
            delta = {}
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        parts.append(_content(delta.get("content")))
        # 少数兼容网关会在流的最终事件中返回完整 message，而不是 delta。
        # 只有在没有任何 delta content 时才使用它，避免重复拼接。
        message_content = _content(message.get("content"))
        if message_content:
            final_message = message_content
        saw_reasoning = saw_reasoning or bool(
            _content(delta.get("reasoning_content")).strip()
            or _content(message.get("reasoning_content")).strip()
        )
        refused = refused or bool(
            _content(delta.get("refusal")).strip()
            or _content(message.get("refusal")).strip()
        )
        current_finish = choice.get("finish_reason")
        if isinstance(current_finish, str):
            finish_reason = current_finish
    text = "".join(parts)
    return _response_result(
        text if text else final_message,
        finish_reason,
        saw_reasoning,
        refused,
    )


def _empty_response_error(result: dict, attempts: int) -> RuntimeError:
    finish_reason = result["finish_reason"] or "missing"
    reasoning_discarded = "true" if result["saw_reasoning"] else "false"
    return RuntimeError(
        "model gateway returned no final content "
        f"after {attempts} attempt(s) "
        f"(finish_reason={finish_reason}, reasoning_content_discarded={reasoning_discarded})"
    )


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
    for attempt in range(1, MAXIMUM_EMPTY_RESPONSE_ATTEMPTS + 1):
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
            result = _read_response(response)
        finally:
            connection.close()

        if result["refused"] or result["finish_reason"] == "content_filter":
            raise RuntimeError("model gateway refused or filtered the completion")
        text = result["text"].strip()
        if text:
            return text

        # 只把“正常结束但正文为空”或“空流”视为一次性上游故障。
        # length、tool_calls 等状态不会靠相同请求自动恢复，因此直接失败。
        if (
            attempt < MAXIMUM_EMPTY_RESPONSE_ATTEMPTS
            and result["finish_reason"] in {None, "stop"}
        ):
            continue
        raise _empty_response_error(result, attempt)

    raise RuntimeError("unreachable model gateway retry state")
