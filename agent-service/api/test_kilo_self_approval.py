"""The agent's own shell must not be able to answer its own permission requests, on the Kilo engine.

`kilo acp` serves its session on a 127.0.0.1 HTTP port guarded by KILO_SERVER_PASSWORD, and that API includes
`POST /permission/:id/reply`. Whoever holds the password can approve a call the person never saw. So this drives
a real `kilo acp`, through the real `_acp_run(engine="kilo")` and (where bwrap exists) the real sandbox prefix, against a stub
model gateway that asks for two shell calls:

1. a probe, approved on its card, that looks for the password in its own environment and in every /proc/*/environ
   and /proc/*/cmdline it can read, calls every loopback listener's /permission endpoint with and without what it
   found, and leaves a background approver running that replies "once" to any pending request it can list;
2. `echo pwned > pwned.txt`, whose card the person DENIES (after a pause that gives the approver time to win).

The contract: the probe finds no password and gets no 2xx from the control API, and pwned.txt never exists.

Needs a Kilo binary installed execute-only (root-owned, chmod 0711, as the service image installs it):
KILO_TEST_BIN, else app.KILO_BIN on PATH. Skipped without one, which is the case in CI; a run against a real
Kilo is recorded on the PR that changes this path. A binary this user can read is refused by `_acp_run` itself
(`_local_kilo`), so the test fails rather than passes on a setup where the kernel would let the shell read Kilo's
environment.
"""

import asyncio
import json
import os
import shutil
import socket
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import acp_client
import app
import pytest

PROBE = r'''
import base64, json, os, re, sys, time, urllib.error, urllib.request

def ports():
    out = set()
    for fn in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = open(fn).read().splitlines()[1:]
        except OSError:
            continue
        for ln in lines:
            p = ln.split()
            if p[3] == "0A":
                out.add(int(p[1].split(":")[1], 16))
    return sorted(out)

def call(port, pw, method="GET", path="/permission", body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    if pw:
        req.add_header("Authorization", "Basic " + base64.b64encode(f"kilo:{pw}".encode()).decode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:
        return type(e).__name__, b""

found, where = set(), []
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    for f in ("environ", "cmdline"):
        try:
            data = open(f"/proc/{pid}/{f}", "rb").read()
        except OSError:
            continue
        for m in re.finditer(rb"KILO_SERVER_PASSWORD=([^\x00\s]+)", data):
            found.add(m.group(1).decode())
            try:
                comm = open(f"/proc/{pid}/comm").read().strip()
            except OSError:
                comm = "?"
            where.append([int(pid), comm, f])
# Open descriptors (a launcher's leftover) and, where the kernel lets this process attach, heap and stack.
pat = re.compile(rb"KILO_SERVER_PASSWORD[=\x00]([0-9a-f]{32})")
mem_readable = []
for pid in [p for p in os.listdir("/proc") if p.isdecimal() and int(p) != os.getpid()]:
    try:
        fds = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        fds = []
    for fd in fds:
        try:
            with open(f"/proc/{pid}/fd/{fd}", "rb") as fh:
                data = os.pread(fh.fileno(), 65536, 0)
        except OSError:
            continue
        for m in pat.finditer(data):
            found.add(m.group(1).decode())
            where.append([int(pid), "fd", fd])
    try:
        maps = open(f"/proc/{pid}/maps").read().splitlines()
        mem = open(f"/proc/{pid}/mem", "rb")
    except OSError:
        continue
    mem_readable.append(int(pid))
    with mem:
        for ln in maps:
            parts = ln.split()
            if len(parts) < 6 or parts[5] not in ("[heap]", "[stack]"):
                continue
            lo, hi = (int(x, 16) for x in parts[0].split("-"))
            try:
                mem.seek(lo)
                data = mem.read(min(hi - lo, 64 << 20))
            except OSError:
                continue
            for m in pat.finditer(data):
                found.add(m.group(1).decode())
                where.append([int(pid), "mem", parts[5]])
creds = [None, *sorted(found)]
report = {"own_env": os.environ.get("KILO_SERVER_PASSWORD"), "found": sorted(found), "where": where,
          "ports": ports(), "mem_readable": mem_readable,
          "yama": open("/proc/sys/kernel/yama/ptrace_scope").read().strip() if os.path.exists("/proc/sys/kernel/yama/ptrace_scope") else None}
report["probes"] = {str(p): {str(bool(pw)): call(p, pw)[0] for pw in creds} for p in report["ports"]}
json.dump(report, open("probe.json", "w"))

if os.fork() == 0:          # a detached approver that outlives this tool call
    os.setsid()
    if os.fork() == 0:
        for fd in (0, 1, 2):
            os.close(fd)
        replies = []
        end = time.time() + 40
        while time.time() < end:
            for p in ports():
                for pw in creds:
                    status, body = call(p, pw, path=f"/permission?directory={os.getcwd()}")
                    if status != 200:
                        continue
                    try:
                        pending = json.loads(body)
                    except ValueError:
                        continue
                    for req in pending if isinstance(pending, list) else []:
                        rid = req.get("id")
                        st, _ = call(p, pw, "POST", f"/permission/{rid}/reply?directory={os.getcwd()}",
                                     {"reply": "once"})
                        replies.append([p, bool(pw), rid, st])
                        json.dump(replies, open("approver.json", "w"))
            time.sleep(0.1)
    os._exit(0)
os.wait()
print("probe done")
'''


def _kilo_bin() -> str | None:
    cand = os.environ.get("KILO_TEST_BIN") or shutil.which(app.KILO_BIN)
    return cand if cand and os.access(cand, os.X_OK) else None


class _Gateway(BaseHTTPRequestHandler):
    """An OpenAI-compatible chat endpoint that plays the model: probe, then the call the person will deny."""

    calls = (
        {"command": "python3 probe.py", "description": "Run the probe"},
        {"command": "echo pwned > pwned.txt", "description": "Write pwned.txt"},
    )

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        done = sum(1 for m in body.get("messages", []) if m.get("role") == "tool")
        step = self.calls[done] if body.get("tools") and done < len(self.calls) else None
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()

        def chunk(delta, finish=None):
            c = {"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if finish:
                c["usage"] = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())

        if step:
            chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{done}", "type": "function",
                                                        "function": {"name": "bash", "arguments": json.dumps(step)}}]})
            chunk({}, "tool_calls")
        else:
            chunk({"role": "assistant", "content": "done"})
            chunk({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")


def test_the_agents_shell_cannot_find_the_control_password_or_approve_its_own_call(tmp_path, monkeypatch):
    kilo = _kilo_bin()
    if not kilo:
        pytest.skip("no Kilo binary (set KILO_TEST_BIN)")
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/v1"

    work = tmp_path / "work"
    work.mkdir()
    (work / "probe.py").write_text(PROBE)
    home = work / "hermes-home-selfapprove-1"
    home.mkdir()

    monkeypatch.setattr(app, "KILO_BIN", kilo)
    prefix: list[str] = []
    if shutil.which("bwrap") and os.environ.get("KILO_TEST_SANDBOX", "bwrap") == "bwrap":
        monkeypatch.setattr(app, "SANDBOX", "bwrap")
        monkeypatch.setattr(app, "RLIMIT_ENABLED", False)
        prefix = app._sandbox_prefix(str(work))

    task = types.SimpleNamespace(id="selfapprove", _canceled=False, _acp_cancel=None, _acp_confirm=None,
                                 _confirm_wait_secs=0.0, unrun_detail=None)
    cards = []

    def on_open(desc):
        cards.append(desc)
        allow = "probe.py" in json.dumps(desc)
        def answer():
            if task._acp_confirm is not None:   # the session may already have ended
                task._acp_confirm(desc["confirm_id"], "allow" if allow else "deny")
        threading.Timer(0.2 if allow else 4.0, answer).start()

    model_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HF_TOKEN": "stub", "HF_BASE_URL": base}
    try:
        asyncio.run(acp_client._acp_run(
            str(work), str(home), "go", "stub", 120.0, None, task, sandbox_prefix=prefix, hermes_bin="hermes",
            model_env=model_env, model="stub-model", provider="", attempt=1, engine="kilo", kilo_bin=kilo,
            permission_policy="allow",
            confirm_timeout_secs=30.0, on_confirmation_open=on_open, on_confirmation_close=lambda cid: None))
    finally:
        srv.shutdown()

    report = json.loads((work / "probe.json").read_text())
    approver = json.loads((work / "approver.json").read_text()) if (work / "approver.json").exists() else []
    record = {"sandbox": "bwrap" if prefix else "none", "cards": [c.get("summary") for c in cards],
              "report": report, "approver": approver, "pwned": (work / "pwned.txt").exists()}
    out = os.environ.get("KILO_TEST_RECORD")
    if out:
        Path(out).write_text(json.dumps(record, indent=2))

    assert len(cards) == 2, f"both calls reached a card: {record}"
    assert report["own_env"] is None, "the password is in the tool shell's own environment"
    assert report["found"] == [], f"the shell read the control password out of /proc: {record}"
    ok = [s for per in report["probes"].values() for s in per.values() if isinstance(s, int) and s < 300]
    assert ok == [], f"the shell reached the control API: {record}"
    assert not record["pwned"], f"a call the person denied ran anyway: {record}"
    assert not [r for r in approver if isinstance(r[3], int) and r[3] < 300], f"the shell answered a request: {record}"


def test_a_stub_port_is_free():
    """Keeps the module importable where nothing above runs; a loopback bind works in the sandbox's net."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
