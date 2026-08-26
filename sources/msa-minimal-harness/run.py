#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
from pathlib import Path

from agent import Agent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--answer", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--profile", default="math")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    agent = Agent(
        root=root,
        profile=args.profile,
        socket_path=os.environ["RSI_MODEL_GATEWAY_SOCKET"],
        api_key=os.environ["RSI_MODEL_GATEWAY_DUMMY_KEY"],
        trace_path=args.trace,
    )
    answer = agent.run(args.task, Path.cwd())
    args.answer.write_text(answer.rstrip() + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
