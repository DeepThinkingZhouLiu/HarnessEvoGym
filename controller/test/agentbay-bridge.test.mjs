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
print("ok")
`
  const { stdout } = await execFileAsync('python3', ['-c', script], {
    cwd: repositoryRoot,
    timeout: 10_000,
  })
  assert.equal(stdout.trim(), 'ok')
})

test('AgentBay bridge 可显式附着已有 session 且不接管其生命周期', async () => {
  const script = String.raw`
import importlib.util
import os
import sys
import types

calls = []

class Session:
    session_id = "s-existing"
    def keep_alive(self):
        pass

class Result:
    exit_code = 0
    stdout = ""
    stderr = ""

class SessionResult:
    session = Session()
    error_message = ""

class AgentBay:
    def get(self, session_id):
        calls.append(("get", session_id))
        return SessionResult()
    def create(self, params):
        calls.append(("create", params))
        return SessionResult()
    def delete(self, session, sync_context=False):
        calls.append(("delete", session.session_id))

class CreateSessionParams:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

class LifecyclePolicy:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

agentbay = types.ModuleType("agentbay")
agentbay.AgentBay = AgentBay
agentbay.CreateSessionParams = CreateSessionParams
common = types.ModuleType("agentbay._common")
params = types.ModuleType("agentbay._common.params")
lifecycle = types.ModuleType("agentbay._common.params.lifecycle_policy")
lifecycle.LifecyclePolicy = LifecyclePolicy
sys.modules.update({
    "agentbay": agentbay,
    "agentbay._common": common,
    "agentbay._common.params": params,
    "agentbay._common.params.lifecycle_policy": lifecycle,
})

spec = importlib.util.spec_from_file_location("agentbay_bridge", "scripts/agentbay-docker-bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.Bridge._vm = lambda self, args, timeout=120: Result()
module.Bridge._ensure_docker = lambda self: None

os.environ.update({
    "AGENTBAY_API_KEY": "test",
    "HARNESS_RSI_AGENTBAY_IMAGE_ID": "img-test",
    "HARNESS_RSI_AGENTBAY_POLICY_ID": "policy-test",
    "HARNESS_RSI_AGENTBAY_EXISTING_SESSION_ID": "s-existing",
})
bridge = module.Bridge()
assert bridge.owns_session is False
bridge.close()
assert calls == [("get", "s-existing")], calls
print("ok")
`
  const { stdout } = await execFileAsync('python3', ['-c', script], {
    cwd: repositoryRoot,
    timeout: 10_000,
  })
  assert.equal(stdout.trim(), 'ok')
})
