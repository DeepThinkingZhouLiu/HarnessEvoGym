"""面向 Cowork 的最小 model -> Bash -> observation 循环。"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from model import query
from tools import run_bash


BASH_PATTERNS = (
    re.compile(r"<bash>\s*(.*?)\s*</bash>", re.DOTALL | re.IGNORECASE),
    re.compile(r"```bash\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE),
)
FINAL_PATTERN = re.compile(r"<final>\s*(.*?)\s*</final>", re.DOTALL | re.IGNORECASE)


def _skill_files(root: Path) -> list[Path]:
    """只枚举真实根目录中的普通 SKILL.md，不跟随符号链接。"""

    try:
        actual_root = root.resolve(strict=True)
    except FileNotFoundError:
        return []
    if not actual_root.is_dir() or actual_root.is_symlink():
        return []
    output: list[Path] = []
    for path in sorted(actual_root.rglob("SKILL.md")):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            path.resolve(strict=True).relative_to(actual_root)
        except (FileNotFoundError, ValueError):
            continue
        output.append(path)
    return output


def _load_skills(roots: list[Path], maximum_files: int, maximum_chars: int) -> str:
    documents: list[str] = []
    used_chars = 0
    for path in [item for root in roots for item in _skill_files(root)]:
        if len(documents) >= maximum_files:
            break
        source = path.read_text(encoding="utf-8")
        remaining = maximum_chars - used_chars
        if remaining <= 0:
            break
        source = source[:remaining]
        documents.append(f"<skill path={json.dumps(str(path))}>\n{source}\n</skill>")
        used_chars += len(source)
    return "\n\n".join(documents)


class Agent:
    def __init__(
        self,
        root: Path,
        profile: str,
        gateway_url: str,
        api_key: str,
        model: str,
        maximum_output_tokens: int,
        maximum_steps: int,
        trace_path: Path,
    ):
        profile_root = root / "profiles"
        self.config = json.loads((profile_root / f"{profile}.json").read_text(encoding="utf-8"))
        prompt = (profile_root / f"{profile}.md").read_text(encoding="utf-8")
        benchmark_root = Path(os.environ.get("RSI_BENCHMARK_SKILLS_ROOT", "/benchmark-skills"))
        skill_text = _load_skills(
            [root / "skills", benchmark_root],
            int(self.config["maximum_skill_files"]),
            int(self.config["maximum_skill_chars"]),
        )
        self.system_prompt = prompt if not skill_text else f"{prompt}\n\nAvailable skills:\n\n{skill_text}"
        self.gateway_url = gateway_url
        self.api_key = api_key
        self.model = model
        self.maximum_output_tokens = min(
            int(self.config["max_output_tokens"]),
            maximum_output_tokens,
        )
        self.maximum_steps = min(int(self.config["max_steps"]), maximum_steps)
        self.trace_path = trace_path

    def trace(self, event: dict) -> None:
        with self.trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    @staticmethod
    def parse(reply: str) -> tuple[str, str] | None:
        final = FINAL_PATTERN.search(reply)
        if final:
            content = final.group(1).strip()
            if content:
                return "final", content
        for pattern in BASH_PATTERNS:
            action = pattern.search(reply)
            if action:
                content = action.group(1).strip()
                if content:
                    return "bash", content
        return None

    def run(self, task: str, workspace: Path) -> str:
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        for step in range(1, self.maximum_steps + 1):
            reply = query(
                self.gateway_url,
                self.api_key,
                self.model,
                messages,
                self.maximum_output_tokens,
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
                    int(self.config["command_timeout_seconds"]),
                    int(self.config["max_observation_chars"]),
                )
                self.trace({
                    "type": "bash",
                    "step": step,
                    "command": parsed[1],
                    "observation": observation,
                })
                messages.append({
                    "role": "user",
                    "content": f"Bash observation:\n{observation}\nContinue with one <bash> or <final> block.",
                })
            else:
                messages.append({
                    "role": "user",
                    "content": "Use exactly one <bash>...</bash> block or one <final>...</final> block.",
                })
        return "The agent exhausted its step budget before completing the requested deliverable."
