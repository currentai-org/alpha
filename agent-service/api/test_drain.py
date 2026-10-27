"""CUR-4598: a deploy's stop signal must not kill the tasks this machine is running.

Each test starts the real server the image runs (serve.py) as its own process, starts a task whose agent
is a stub that takes a few seconds and writes a file, and sends the process SIGTERM mid-task, which is what
Fly sends when a deploy replaces the machine. Fly then waits kill_timeout before it stops the machine; the
tests give the process a bound well inside that.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

API = Path(__file__).resolve().parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path):
    """Start serve.py with an agent stub; yield (process, base url, log path). The stub sleeps
    STUB_SECS, writes result.txt in its working directory, and prints the answer."""
    procs = []

    def start(stub_secs: float, **env_overrides: str):
        stub = tmp_path / "hermes-stub.sh"
        stub.write_text(f'#!/bin/sh\nsleep {stub_secs}\necho "drained answer" > result.txt\n'
                        'echo "The answer is in result.txt."\n')
        stub.chmod(0o755)
        port = _free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AGENT_", "MODEL_", "HERMES_"))}
        env.update({
            "AGENT_AUTH_DISABLED": "1", "AGENT_MODERATION_DISABLED": "1", "AGENT_WATCHDOG_SECS": "0",
            "AGENT_DB_PATH": str(tmp_path / "tasks.db"), "AGENT_SCRATCH_ROOT": str(tmp_path),
            "AGENT_SANDBOX_BACKEND": "bwrap", "AGENT_ACP": "0", "HERMES_BIN": str(stub),
            "AGENT_PORT": str(port), "AGENT_HOST": "127.0.0.1", "PYTHONUNBUFFERED": "1",
            **env_overrides,
        })
        log = tmp_path / "server.log"
        proc = subprocess.Popen([sys.executable, "serve.py"], cwd=API, env=env,
                                stdout=log.open("w"), stderr=subprocess.STDOUT)
        procs.append(proc)
        base = f"http://127.0.0.1:{port}"
        for _ in range(100):
            try:
                if httpx.get(f"{base}/healthz", timeout=1).status_code == 200:
                    return proc, base, log
            except httpx.TransportError:
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        raise AssertionError(f"server did not come up:\n{log.read_text()}")

    yield start
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait(5)


def _stream_events(base: str, task_id: str, frames: list, finished: threading.Event) -> None:
    """Read the task's SSE stream into `frames` as (event, data) until it ends or drops."""
    try:
        with httpx.stream("GET", f"{base}/run/{task_id}/events", timeout=httpx.Timeout(60, connect=5)) as r:
            event = None
            for line in r.iter_lines():
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and event:
                    frames.append((event, json.loads(line.split(":", 1)[1])))
    except httpx.HTTPError as e:
        frames.append(("dropped", {"error": type(e).__name__}))
    finally:
        finished.set()


def _start_task(base: str, session: str) -> str:
    r = httpx.post(f"{base}/run", json={"prompt": "write the result file", "session_id": session}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _wait_running(base: str, task_id: str) -> None:
    for _ in range(50):
        if httpx.get(f"{base}/run/{task_id}", timeout=5).json()["state"] not in ("SUBMITTED", "QUEUED"):
            return
        time.sleep(0.1)


def test_a_task_running_at_the_stop_signal_finishes_with_its_answer_and_file_cur4598(server):
    """The contract: SIGTERM mid-task does not end the task. Its stream carries `done` COMPLETED with the
    answer, its file still downloads afterwards (a new request, the way chat saves it), a new /run is told
    to retry rather than refused at the socket, and the process exits on its own once the task is done."""
    proc, base, log = server(stub_secs=4)
    task_id = _start_task(base, "s-drain-1")
    frames, finished = [], threading.Event()
    threading.Thread(target=_stream_events, args=(base, task_id, frames, finished), daemon=True).start()
    _wait_running(base, task_id)

    proc.send_signal(signal.SIGTERM)
    time.sleep(0.3)
    refused = httpx.post(f"{base}/run", json={"prompt": "another", "session_id": "s-drain-2"}, timeout=5)
    assert refused.status_code == 503 and refused.headers.get("retry-after"), (
        f"a /run during the drain must be a retryable 503, got {refused.status_code}: {refused.text}")

    assert finished.wait(30), "the event stream never ended"
    done = [d for e, d in frames if e == "done"]
    assert done and done[0]["state"] == "COMPLETED", f"the task did not finish through the stop signal: {frames}"
    assert "result.txt" in done[0]["result"], done[0]
    assert [a["name"] for a in done[0]["artifacts"]] == ["result.txt"], done[0]

    file = httpx.get(f"{base}/sessions/s-drain-1/artifacts/result.txt", timeout=5)
    assert file.status_code == 200 and file.text.strip() == "drained answer", (
        f"the task's file must still download after it finished in the drain: {file.status_code} {file.text!r}")

    assert proc.wait(30) is not None, "the process did not exit once its running task was done"
    assert "shutdown.drained" in log.read_text()


def test_a_task_outlasting_the_drain_ends_as_a_restart_with_a_done_frame_not_a_dropped_stream_cur4598(server):
    """The contract when a task runs past AGENT_DRAIN_SECS: its stream still gets a `done` frame, FAILED
    with interrupted="restart" (what chat turns into "the service restarted, try again"), before the
    process exits, and the durable record says the same for a reader after the restart."""
    proc, base, _log = server(stub_secs=60, AGENT_DRAIN_SECS="2", AGENT_DRAIN_LINGER_SECS="1")
    task_id = _start_task(base, "s-drain-3")
    frames, finished = [], threading.Event()
    threading.Thread(target=_stream_events, args=(base, task_id, frames, finished), daemon=True).start()
    _wait_running(base, task_id)

    proc.send_signal(signal.SIGTERM)
    assert finished.wait(25), "the event stream never ended"
    done = [d for e, d in frames if e == "done"]
    assert done, f"the stream ended without a done frame (a dropped stream): {frames}"
    assert done[0]["state"] == "FAILED" and done[0]["interrupted"] == "restart", done[0]
    assert proc.wait(20) is not None
