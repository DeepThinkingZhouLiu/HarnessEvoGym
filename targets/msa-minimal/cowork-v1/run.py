#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
from pathlib import Path

from agent import Agent


def _integer_environment(name: str, minimum: int) -> int:
    value = int(os.environ[name])
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--answer", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--profile", default="cowork")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    agent = Agent(
        root=root,
        profile=args.profile,
        gateway_url=os.environ["RSI_MODEL_GATEWAY_BASE_URL"],
        api_key=os.environ["RSI_MODEL_GATEWAY_DUMMY_KEY"],
        model=os.environ["RSI_MODEL_GATEWAY_MODEL"],
        maximum_output_tokens=_integer_environment("RSI_MODEL_GATEWAY_MAX_TOKENS", 1),
        maximum_steps=_integer_environment("RSI_SOLVER_MAX_STEPS", 0),
        wall_time_seconds=_integer_environment("RSI_SOLVER_WALL_TIME_SECONDS", 1),
        trace_path=args.trace,
    )
    answer = agent.run(args.task, Path.cwd())
    args.answer.write_text(answer.rstrip() + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
