#!/usr/bin/env python3
"""Download the pinned, gated HLE dataset and export only text-only Math rows."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile

from datasets import load_dataset


DATASET = "cais/hle"
REVISION = "5a81a4c7271a2a2a312b9a690f0c2fde837e4c29"
FIELDS = ("id", "question", "answer", "answer_type", "raw_subject", "category")


def read_token(fd: int | None) -> str | bool:
    if fd is None:
        # True asks huggingface_hub to use its existing local login without
        # copying a token into argv or the process environment.
        return True
    if fd < 3:
        raise ValueError("--hf-token-fd must be an inherited descriptor >= 3")
    with os.fdopen(os.dup(fd), "r", encoding="utf-8") as handle:
        token = handle.read(65537)
    token = token.rstrip("\r\n")
    if len(token) < 8 or len(token) > 65536 or "\n" in token or "\r" in token:
        raise ValueError("invalid Hugging Face token descriptor")
    return token


def text_only_math(row: dict) -> bool:
    return (
        str(row.get("category", "")).strip().lower() == "math"
        and row.get("image") in (None, "")
        and row.get("image_preview") in (None, "")
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--hf-token-fd", type=int)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite {output}")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output.parent, 0o700)

    token = read_token(args.hf_token_fd)
    dataset = load_dataset(DATASET, revision=REVISION, split="test", token=token)
    rows = []
    for row in dataset:
        if not text_only_math(row):
            continue
        value = {field: row.get(field) for field in FIELDS}
        if any(not isinstance(value[field], str) or not value[field].strip()
               for field in ("id", "question", "answer", "answer_type")):
            raise ValueError("eligible HLE row has a missing required field")
        rows.append(value)
    if len(rows) < 200:
        raise ValueError(f"only {len(rows)} eligible text-only Math rows; need at least 200")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".partial", dir=output.parent
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary_name, output)
        os.chmod(output, 0o600)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    print(json.dumps({"dataset": DATASET, "revision": REVISION, "eligible": len(rows)}))


if __name__ == "__main__":
    main()
