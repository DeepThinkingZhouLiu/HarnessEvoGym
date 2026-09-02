#!/usr/bin/env python3
"""Private JSON-lines bridge from the Node controller to AgentBay.

One process owns one AgentBay VM. Requests never echo their input, because
Docker environment files can contain short-lived gateway credentials.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from pathlib import Path


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def result_fields(result) -> dict:
    return {
        "exitCode": int(getattr(result, "exit_code", -1)),
        "stdout": str(getattr(result, "stdout", "") or getattr(result, "output", "") or ""),
        "stderr": str(getattr(result, "stderr", "") or getattr(result, "error_message", "") or ""),
    }


class Bridge:
    def __init__(self) -> None:
        try:
            from agentbay._common.logger import get_logger

            get_logger().remove()
        except Exception:
            pass
        from agentbay import AgentBay, CreateSessionParams
        from agentbay._common.params.lifecycle_policy import LifecyclePolicy

        key = os.environ.get("AGENTBAY_API_KEY", "")
        image_id = os.environ.get("HARNESS_RSI_AGENTBAY_IMAGE_ID", "")
        policy_id = os.environ.get("HARNESS_RSI_AGENTBAY_POLICY_ID", "")
        if not key or not image_id or not policy_id:
            raise RuntimeError(
                "AGENTBAY_API_KEY, HARNESS_RSI_AGENTBAY_IMAGE_ID and "
                "HARNESS_RSI_AGENTBAY_POLICY_ID are required"
            )
        os.environ.setdefault("AGENTBAY_TIMEOUT_MS", "900000")
        self.client = AgentBay()
        created = self.client.create(
            CreateSessionParams(
                image_id=image_id,
                policy_id=policy_id,
                lifecycle_policy=LifecyclePolicy(idle_release_timeout=900, max_runtime=21600),
            )
        )
        self.session = getattr(created, "session", None)
        if self.session is None:
            raise RuntimeError(f"AgentBay session creation failed: {getattr(created, 'error_message', '')}")
        self.remote_root = f"/tmp/harness-rsi-{uuid.uuid4().hex}"
        self._vm(["mkdir", "-p", self.remote_root], 30)
        self._ensure_docker()
        self.keepalive_stop = threading.Event()
        self.keepalive = threading.Thread(target=self._keepalive_loop, daemon=True)
        self.keepalive.start()

    def _keepalive_loop(self) -> None:
        while not self.keepalive_stop.wait(300):
            try:
                self.session.keep_alive()
            except Exception:
                pass

    def _vm(self, args: list[str], timeout: int = 120):
        command = shlex.join(args)
        last = None
        for attempt in range(1, 4):
            try:
                value = self.session.command.run(command, timeout_ms=max(1, timeout) * 1000)
                fields = result_fields(value)
                if fields["exitCode"] == 0:
                    return value
                return value
            except Exception as exc:
                last = exc
                if attempt < 3:
                    time.sleep(attempt * 2)
        raise RuntimeError(f"AgentBay command transport failed after 3 attempts: {type(last).__name__}: {last}")

    def _checked(self, args: list[str], timeout: int = 120):
        value = self._vm(args, timeout)
        fields = result_fields(value)
        if fields["exitCode"] != 0:
            tail = (fields["stderr"] or fields["stdout"])[-2000:]
            raise RuntimeError(f"remote command failed (exit={fields['exitCode']}): {tail}")
        return value

    def _long_vm(self, args: list[str], timeout: int) -> dict:
        tag = uuid.uuid4().hex
        stdout_path = f"{self.remote_root}/long-{tag}.out"
        stderr_path = f"{self.remote_root}/long-{tag}.err"
        rc_path = f"{self.remote_root}/long-{tag}.rc"
        pid_path = f"{self.remote_root}/long-{tag}.pid"
        inner = (
            f"{shlex.join(args)} >{shlex.quote(stdout_path)} 2>{shlex.quote(stderr_path)}; "
            f"rc=$?; printf %s \"$rc\" >{shlex.quote(rc_path)}"
        )
        started = self._checked(
            ["sh", "-lc", f"nohup setsid sh -c {shlex.quote(inner)} >/dev/null 2>&1 & echo $! >{shlex.quote(pid_path)}"],
            30,
        )
        del started
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            probe = self._vm(["sh", "-lc", f"test -f {shlex.quote(rc_path)} && cat {shlex.quote(rc_path)}"], 30)
            fields = result_fields(probe)
            if fields["exitCode"] == 0 and fields["stdout"].strip():
                rc = int(fields["stdout"].strip().splitlines()[-1])
                output = self._vm(["tail", "-c", "8388608", stdout_path], 120)
                errors = self._vm(["tail", "-c", "8388608", stderr_path], 120)
                self._vm(["rm", "-f", stdout_path, stderr_path, rc_path, pid_path], 30)
                return {
                    "exitCode": rc,
                    "stdout": result_fields(output)["stdout"],
                    "stderr": result_fields(errors)["stdout"],
                }
            time.sleep(10)
        self._vm(
            ["sh", "-lc", f"test -f {shlex.quote(pid_path)} && sudo kill -TERM -- -$(cat {shlex.quote(pid_path)}) 2>/dev/null || true"],
            30,
        )
        return {"exitCode": 124, "stdout": "", "stderr": f"remote command timed out after {timeout}s"}

    def _ensure_docker(self) -> None:
        probe = self._vm(["sh", "-lc", "command -v docker >/dev/null && sudo docker info >/dev/null"], 30)
        if result_fields(probe)["exitCode"] != 0:
            self._checked(
                ["sh", "-lc", "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io"],
                900,
            )
        mirror = os.environ.get("HARNESS_RSI_AGENTBAY_REGISTRY_MIRROR", "https://docker.1panel.live")
        daemon = {"registry-mirrors": [mirror]} if mirror else {}
        encoded = json.dumps(daemon, separators=(",", ":"))
        self._checked(
            [
                "sh",
                "-lc",
                f"printf %s {shlex.quote(encoded)} | sudo tee /etc/docker/daemon.json >/dev/null && "
                "(sudo systemctl restart docker 2>/dev/null || "
                "(sudo pkill dockerd 2>/dev/null || true; sudo nohup dockerd >/tmp/harness-rsi-dockerd.log 2>&1 & sleep 6))",
            ],
            90,
        )
        self._checked(["sudo", "docker", "info"], 30)

    def upload_archive(self, local_path: str, remote_dir: str) -> None:
        source = Path(local_path).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="harness-rsi-agentbay-") as temporary:
            archive = Path(temporary) / "payload.tar"
            with tarfile.open(archive, "w") as bundle:
                if source.is_dir():
                    for child in sorted(source.iterdir(), key=lambda item: item.name):
                        if child.name in {".git", ".rsi", "node_modules", ".pnpm-store"}:
                            continue
                        bundle.add(child, arcname=child.name, recursive=True)
                else:
                    bundle.add(source, arcname=source.name, recursive=False)
            remote_archive = f"{self.remote_root}/upload-{uuid.uuid4().hex}.tar"
            uploaded = self.session.file_system.upload_file(
                local_path=str(archive), remote_path=remote_archive
            )
            if not getattr(uploaded, "success", True):
                raise RuntimeError(f"AgentBay upload failed: {getattr(uploaded, 'error_message', '')}")
            self._checked(["rm", "-rf", remote_dir], 60)
            self._checked(["mkdir", "-p", remote_dir], 30)
            self._checked(["tar", "-xf", remote_archive, "-C", remote_dir], 600)
            self._checked(["rm", "-f", remote_archive], 30)

    def download_archive(self, remote_dir: str, local_path: str) -> None:
        target = Path(local_path).resolve()
        remote_archive = f"{self.remote_root}/download-{uuid.uuid4().hex}.tar"
        self._checked(["sudo", "tar", "-cf", remote_archive, "-C", remote_dir, "."], 600)
        self._checked(["sudo", "chmod", "0644", remote_archive], 30)
        with tempfile.TemporaryDirectory(prefix="harness-rsi-agentbay-") as temporary:
            archive = Path(temporary) / "payload.tar"
            downloaded = self.session.file_system.download_file(
                remote_path=remote_archive, local_path=str(archive)
            )
            if not getattr(downloaded, "success", True):
                raise RuntimeError(f"AgentBay download failed: {getattr(downloaded, 'error_message', '')}")
            target.mkdir(parents=True, exist_ok=True)
            for child in target.iterdir():
                if child.is_dir() and not child.is_symlink():
                    import shutil

                    shutil.rmtree(child)
                else:
                    child.unlink()
            with tarfile.open(archive, "r") as bundle:
                members = bundle.getmembers()
                for member in members:
                    member.uid = os.getuid()
                    member.gid = os.getgid()
                    member.uname = ""
                    member.gname = ""
                bundle.extractall(target, members=members, filter="data")
        self._checked(["rm", "-f", remote_archive], 30)

    def request(self, request: dict) -> dict:
        operation = request.get("operation")
        if operation == "docker":
            args = request.get("args")
            if not isinstance(args, list) or not all(isinstance(value, str) for value in args):
                raise RuntimeError("docker args must be strings")
            environment = request.get("secretEnvironment", {})
            if not isinstance(environment, dict) or not all(
                isinstance(name, str) and isinstance(value, str)
                for name, value in environment.items()
            ):
                raise RuntimeError("secretEnvironment must contain strings")
            remote_environment = None
            try:
                if environment:
                    with tempfile.NamedTemporaryFile(
                        mode="w", encoding="utf-8", prefix="harness-rsi-env-", delete=False
                    ) as stream:
                        local_environment = stream.name
                        for name, value in environment.items():
                            if not name.replace("_", "A").isalnum() or "\n" in value or "\0" in value:
                                raise RuntimeError("invalid secret environment entry")
                            stream.write(f"{name}={value}\n")
                    remote_environment = f"{self.remote_root}/env-{uuid.uuid4().hex}"
                    uploaded = self.session.file_system.upload_file(
                        local_path=local_environment, remote_path=remote_environment
                    )
                    os.unlink(local_environment)
                    if not getattr(uploaded, "success", True):
                        raise RuntimeError(f"AgentBay env upload failed: {getattr(uploaded, 'error_message', '')}")
                    expanded = []
                    for argument in args:
                        if argument == "__HARNESS_RSI_SECRET_ENV_FILE__":
                            expanded.extend(["--env-file", remote_environment])
                        else:
                            expanded.append(argument)
                    args = expanded
                command = ["sudo", "docker", *args]
                timeout = int(request.get("timeoutSeconds", 120))
                if timeout > 180:
                    return self._long_vm(command, timeout)
                value = self._vm(command, timeout)
                return result_fields(value)
            finally:
                if remote_environment:
                    self._vm(["rm", "-f", remote_environment], 30)
        if operation == "uploadDir":
            self.upload_archive(request["localPath"], request["remotePath"])
            return {"ok": True}
        if operation == "downloadDir":
            self.download_archive(request["remotePath"], request["localPath"])
            return {"ok": True}
        if operation == "allocatePath":
            return {"path": f"{self.remote_root}/{uuid.uuid4().hex}"}
        if operation == "removePath":
            remote_path = str(request["remotePath"])
            if not remote_path.startswith(self.remote_root + "/"):
                raise RuntimeError("refusing to remove path outside bridge root")
            self._checked(["rm", "-rf", remote_path], 120)
            return {"ok": True}
        if operation == "preparePath":
            remote_path = str(request["remotePath"])
            if not remote_path.startswith(self.remote_root + "/"):
                raise RuntimeError("refusing to prepare path outside bridge root")
            uid = int(request["uid"])
            gid = int(request["gid"])
            self._checked(["sudo", "chown", "-R", f"{uid}:{gid}", remote_path], 120)
            return {"ok": True}
        if operation == "identity":
            uid = int(result_fields(self._checked(["id", "-u"], 30))["stdout"].strip())
            gid = int(result_fields(self._checked(["id", "-g"], 30))["stdout"].strip())
            if uid == 0 or gid == 0:
                uid = gid = 1000
            return {"uid": uid, "gid": gid}
        if operation == "session":
            return {"sessionId": self.session.session_id}
        raise RuntimeError(f"unknown operation: {operation}")

    def close(self) -> None:
        self.keepalive_stop.set()
        self.keepalive.join(timeout=2)
        try:
            self._vm(["rm", "-rf", self.remote_root], 60)
        finally:
            self.client.delete(self.session, sync_context=False)


def main() -> int:
    bridge = None
    try:
        bridge = Bridge()
        for line in sys.stdin:
            try:
                request = json.loads(line)
                emit({"id": request.get("id"), "result": bridge.request(request)})
            except Exception as exc:
                emit({"id": request.get("id") if "request" in locals() else None, "error": f"{type(exc).__name__}: {exc}"})
        return 0
    except Exception as exc:
        emit({"id": None, "error": f"{type(exc).__name__}: {exc}"})
        return 1
    finally:
        if bridge is not None:
            try:
                bridge.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
