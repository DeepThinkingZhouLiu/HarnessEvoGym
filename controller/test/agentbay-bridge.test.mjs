import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('AgentBay bridge 串行控制面调用并并发处理已提交请求', async () => {
  const script = String.raw`
import importlib.util
import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location("agentbay_bridge", "scripts/agentbay-docker-bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

active = 0
maximum_active = 0
counter_lock = threading.Lock()

class Result:
    exit_code = 0
    stdout = "ok"
    stderr = ""

class Command:
    def run(self, command, timeout_ms):
        global active, maximum_active
        with counter_lock:
            active += 1
            maximum_active = max(maximum_active, active)
        time.sleep(0.03)
        with counter_lock:
            active -= 1
        return Result()

control_bridge = object.__new__(module.Bridge)
control_bridge.session = type("Session", (), {"command": Command()})()
control_bridge._control_plane_lock = threading.Lock()
with ThreadPoolExecutor(max_workers=4) as executor:
    list(executor.map(lambda value: control_bridge._vm(["true"], 1), range(4)))
assert maximum_active == 1, maximum_active

class ConcurrentBridge:
    def request(self, request):
        time.sleep(request["delay"])
        return {"ok": request["id"]}

responses = []
responses_lock = threading.Lock()
def capture(value):
    with responses_lock:
        responses.append(value)

lines = io.StringIO(
    json.dumps({"id": 1, "delay": 0.12}) + "\n" +
    json.dumps({"id": 2, "delay": 0.01}) + "\n"
)
module.serve_requests(ConcurrentBridge(), lines, capture, maximum_workers=2)
assert [value["id"] for value in responses] == [2, 1], responses

ready_calls = []
lazy_bridge = object.__new__(module.Bridge)
lazy_bridge.session = type("Session", (), {"session_id": "session-fixture"})()
lazy_bridge.remote_root = "/tmp/fixture"
lazy_bridge._ready = False
lazy_bridge._ready_lock = threading.Lock()
lazy_bridge._checked = lambda args, timeout=120: ready_calls.append((args, timeout))
lazy_bridge._ensure_docker = lambda: ready_calls.append(("docker", 0))
assert lazy_bridge.request({"operation": "session"}) == {"sessionId": "session-fixture"}
assert ready_calls == [], ready_calls
lazy_bridge.request({"operation": "allocatePath"})
assert len(ready_calls) == 2, ready_calls
lazy_bridge.request({"operation": "allocatePath"})
assert len(ready_calls) == 2, ready_calls
print("ok")
`
  const { stdout } = await execFileAsync('python3', ['-c', script], {
    cwd: repositoryRoot,
    timeout: 10_000,
  })
  assert.equal(stdout.trim(), 'ok')
})
