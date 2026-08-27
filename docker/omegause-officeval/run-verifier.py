"""在隔离容器中调用单个 OmegaUse-OfficeVal Verifier。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


REQUIRED_FIELDS = {
    "id",
    "file_name",
    "status",
    "error",
    "dim1_pass",
    "dim1_reason",
    "dim2_items",
    "total_score",
    "max_score",
}


def _regular_file(path: Path, label: str) -> Path:
    source_stat = path.stat(follow_symlinks=False)
    if path.is_symlink() or not path.is_file() or source_stat.st_nlink != 1:
        raise RuntimeError(f"{label} 不是独立普通文件")
    resolved = path.resolve(strict=True)
    resolved_stat = resolved.stat(follow_symlinks=False)
    if not resolved.is_file() or resolved_stat.st_nlink != 1:
        raise RuntimeError(f"{label} 不是独立普通文件")
    return resolved


def _load_verifier(path: Path):
    verifier = _regular_file(path, "Verifier")
    sys.path.insert(0, str(verifier.parent))
    spec = importlib.util.spec_from_file_location("trusted_officeval_verifier", verifier)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法创建 Verifier Module Spec")
    module = importlib.util.module_from_spec(spec)
    # dataclasses 等标准库会在装饰器执行期间通过 cls.__module__ 回查
    # sys.modules。动态加载模块必须先登记，否则包含 @dataclass 的上游
    # OfficeVal Verifier 会在 import 阶段失败。
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    if not callable(getattr(module, "evaluate", None)):
        raise RuntimeError("Verifier 缺少 evaluate(directory) 函数")
    return module


def _validate_result(result: object, expected_id: str) -> dict:
    if not isinstance(result, dict):
        raise RuntimeError("Verifier 返回值不是对象")
    missing = sorted(REQUIRED_FIELDS - result.keys())
    if missing:
        raise RuntimeError(f"Verifier 返回值缺少字段：{missing}")
    expected_short_id = expected_id.removeprefix("officeval_")
    if str(result["id"]).removeprefix("officeval_") != expected_short_id:
        raise RuntimeError("Verifier 返回的 ID 与任务不一致")
    if result["status"] not in {"ok", "error"}:
        raise RuntimeError("Verifier status 只能是 ok 或 error")
    if not isinstance(result["dim1_pass"], bool):
        raise RuntimeError("Verifier dim1_pass 不是布尔值")
    if not isinstance(result["dim2_items"], list):
        raise RuntimeError("Verifier dim2_items 不是数组")
    for field in ("total_score", "max_score"):
        if isinstance(result[field], bool) or not isinstance(result[field], (int, float)):
            raise RuntimeError(f"Verifier {field} 不是有限数字")
        if not (-1e12 < float(result[field]) < 1e12):
            raise RuntimeError(f"Verifier {field} 超出安全范围")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verifier", required=True)
    parser.add_argument("--submission", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-id", required=True)
    args = parser.parse_args()

    submission_input = Path(args.submission)
    if submission_input.is_symlink():
        raise RuntimeError("Submission 不是安全目录")
    submission = submission_input.resolve(strict=True)
    if not submission.is_dir():
        raise RuntimeError("Submission 不是安全目录")
    output = Path(args.output)
    if output.exists():
        raise RuntimeError("Verifier 输出文件运行前必须不存在")
    module = _load_verifier(Path(args.verifier))
    os.chdir(submission)
    result = _validate_result(module.evaluate(str(submission)), args.expected_id)
    output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
