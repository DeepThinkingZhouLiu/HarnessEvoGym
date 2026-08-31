"""The single writable-workspace tool used by the minimal agent."""

from __future__ import annotations

import json
import os
import signal
import subprocess


def _trim(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n... {len(text) - limit} chars omitted ...\n" + text[-half:]


def _decode_output(output: bytes) -> str:
    """Shell 输出可能包含 Office 文件原始字节，不能假设一定是 UTF-8。"""

    return output.decode("utf-8", errors="replace")


def run_bash(command: str, cwd: str, timeout: int, output_limit: int) -> str:
    process = subprocess.Popen(
        ["/bin/bash", "-lc", command],
        cwd=cwd,
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout)
        result = {
            "returncode": process.returncode,
            "output": _trim(_decode_output(output), output_limit),
        }
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        result = {
            "returncode": -1,
            "output": _trim(_decode_output(output), output_limit),
            "error": f"command timed out after {timeout}s",
        }
    return json.dumps(result, ensure_ascii=False)
