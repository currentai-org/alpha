"""pytest bootstrap for the agent-service unit tests.

Runs before any test module is imported, so it must set up two things that the modules under test
bind at import time:
  1. AGENT_DB_PATH=:memory: — Store() reads DB_PATH when `app` is first imported.
  2. the api/ dir on sys.path — so `import app` / `import proxy` work regardless of the cwd pytest
     was launched from.
"""
import os
import sys
from pathlib import Path

os.environ["AGENT_DB_PATH"] = ":memory:"
# The watchdog exits the process when localhost:8731 does not answer, which in a test run is always. (CUR-4406)
os.environ["AGENT_WATCHDOG_SECS"] = "0"
# Tests call /run with no X-Agent-Account; the ones about the refusal turn it on themselves. (CUR-4402)
os.environ.setdefault("AGENT_REQUIRE_ACCOUNT", "0")
# The code defaults to e2b, which refuses to boot without an E2B install; the suite runs the host-local runner.
os.environ.setdefault("AGENT_SANDBOX_BACKEND", "bwrap")
sys.path.insert(0, str(Path(__file__).resolve().parent))
