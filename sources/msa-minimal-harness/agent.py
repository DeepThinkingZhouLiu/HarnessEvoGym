"""A mini-swe-agent-style model -> Bash -> observation loop."""

from __future__ import annotations

import json
import re
from pathlib import Path

from model import query
from tools import run_bash


BASH_PATTERNS = (
    re.compile(r"<bash>\s*(.*?)\s*</bash>", re.DOTALL | re.IGNORECASE),
    re.compile(r"```bash\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE),
)
FINAL_PATTERN = re.compile(r"<final>\s*(.*?)\s*</final>", re.DOTALL | re.IGNORECASE)


class Agent:
    def __init__(self, root: Path, profile: str, socket_path: str, api_key: str, trace_path: Path):
        profile_root = root / "profiles"
        self.config = json.loads((profile_root / f"{profile}.json").read_text())
        self.system_prompt = (profile_root / f"{profile}.md").read_text()
        self.socket_path = socket_path
        self.api_key = api_key
        self.trace_path = trace_path

    def trace(self, event: dict) -> None:
        with self.trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    @staticmethod
    def parse(reply: str) -> tuple[str, str] | None:
        final = FINAL_PATTERN.search(reply)
        if final:
            return "final", final.group(1).strip()
        if all(label in reply for label in ("Explanation:", "Answer:", "Confidence:")):
            return "final", reply[reply.index("Explanation:"):].strip()
        for pattern in BASH_PATTERNS:
            action = pattern.search(reply)
            if action:
                return "bash", action.group(1).strip()
        return None

    def run(self, task: str, workspace: Path) -> str:
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        for step in range(1, self.config["max_steps"] + 1):
            reply = query(
                self.socket_path,
                self.api_key,
                messages,
                self.config["max_output_tokens"],
            )
            self.trace({"type": "model", "step": step, "content": reply})
            parsed = self.parse(reply)
            if parsed and parsed[0] == "final":
                return parsed[1]
            messages.append({"role": "assistant", "content": reply})
            if parsed and parsed[0] == "bash":
                observation = run_bash(
                    parsed[1],
                    str(workspace),
                    self.config["command_timeout_seconds"],
                    self.config["max_observation_chars"],
                )
                self.trace({"type": "bash", "step": step, "command": parsed[1], "observation": observation})
                messages.append({
                    "role": "user",
                    "content": f"Bash observation:\n{observation}\nContinue with one <bash> or <final> block.",
                })
            else:
                messages.append({
                    "role": "user",
                    "content": "Use exactly one <bash>...</bash> block or one <final>...</final> block.",
                })
        return "Explanation: The agent exhausted its step budget.\nAnswer: \nConfidence: 0"
