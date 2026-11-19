"""The docker sandbox backend against a fake Docker API client.

The fake records every call the backend makes and answers exec from a small table, so these tests pin the create
body's hardening, the network each tier gets, the name a conversation's container is found by, and what cleanup
removes. The real proxy and daemon are exercised by .github/selfhost-docker-sandbox-smoke.py in CI."""

from __future__ import annotations

import asyncio
import base64
import socket
import struct

import pytest
from sandbox_backend import CannotAttach, SandboxError, Tier, key_for
from sandbox_docker import WORK, DockerBackend, DockerConfig, frames

IMAGE = "example.org/sandbox@sha256:" + "a" * 64


class ApiError(Exception):
    def __init__(self, status_code: int, msg: str = ""):
        super().__init__(msg or f"status {status_code}")
        self.status_code = status_code


class FakeApi:
    def __init__(self):
        self.calls: list[tuple[str, tuple, dict]] = []
        self.containers_by_name: dict[str, dict] = {}
        self.networks_by_name: dict[str, dict] = {}
        self.execs: dict[str, dict] = {}
        self.exec_answer = lambda argv: (b"", b"", 0)
        self.files: dict[str, bytes] = {}
        self.fail_inspect: Exception | None = None

    def _rec(self, call, /, *a, **k):
        self.calls.append((call, a, k))

    def called(self, name):
        return [c for c in self.calls if c[0] == name]

    def inspect_container(self, name):
        self._rec("inspect_container", name)
        if self.fail_inspect:
            raise self.fail_inspect
        if name not in self.containers_by_name:
            raise ApiError(404)
        return self.containers_by_name[name]

    def create_container(self, image, **k):
        self._rec("create_container", image, **k)
        if k["name"] in self.containers_by_name:
            raise ApiError(409)
        info = {"Id": "c-" + k["name"], "Config": {"Labels": k["labels"]}, "State": {"Running": False},
                "Created": 1000, "Labels": k["labels"], "Name": k["name"]}
        self.containers_by_name[k["name"]] = info
        return {"Id": info["Id"]}

    def start(self, cid):
        self._rec("start", cid)
        for info in self.containers_by_name.values():
            if info["Id"] == cid:
                info["State"] = {"Running": True}

    def remove_container(self, name, force=False):
        self._rec("remove_container", name, force=force)
        if self.containers_by_name.pop(name, None) is None:
            raise ApiError(404)

    def containers(self, all=False, filters=None):
        self._rec("containers", all=all, filters=filters)
        return [{"Labels": i["Labels"], "Created": i["Created"],
                 "State": "running" if i["State"].get("Running") else "exited"} for i in self.containers_by_name.values()]

    def create_network(self, name, **k):
        self._rec("create_network", name, **k)
        if name in self.networks_by_name:
            raise ApiError(409)
        self.networks_by_name[name] = {"Name": name, **k}

    def connect_container_to_network(self, container, net, **k):
        self._rec("connect_container_to_network", container, net, **k)

    def disconnect_container_from_network(self, container, net, **k):
        self._rec("disconnect_container_from_network", container, net, **k)

    def remove_network(self, name):
        self._rec("remove_network", name)
        if self.networks_by_name.pop(name, None) is None:
            raise ApiError(404)

    def networks(self, filters=None):
        self._rec("networks", filters=filters)
        return list(self.networks_by_name.values())

    def exec_create(self, cid, cmd, **k):
        self._rec("exec_create", cid, cmd, **k)
        eid = f"e{len(self.execs)}"
        self.execs[eid] = {"cmd": cmd, **k}
        return {"Id": eid}

    def exec_start(self, eid, demux=False, socket=False):
        self._rec("exec_start", eid, demux=demux, socket=socket)
        out, err, code = self.exec_answer(self.execs[eid]["cmd"])
        self.execs[eid]["ExitCode"] = code
        return out, err

    def exec_inspect(self, eid):
        return {"ExitCode": self.execs[eid].get("ExitCode"), "Running": False}


def backend(api: FakeApi | None = None, **cfg) -> tuple[DockerBackend, FakeApi]:
    api = api or FakeApi()
    conf = {"docker_host": "tcp://sockguard:2375", "image": IMAGE, "gateway_host": "gateway",
            "gateway_container": "alpha-agent-proxy-1", **cfg}
    return DockerBackend(DockerConfig(**conf), client=api), api


def test_config_refuses_the_raw_socket_an_unpinned_image_and_half_a_gateway():
    with pytest.raises(ValueError, match="tcp://"):
        DockerConfig(docker_host="unix:///var/run/docker.sock", image=IMAGE)
    with pytest.raises(ValueError, match="digest"):
        DockerConfig(docker_host="tcp://sockguard:2375", image="debian:bookworm-slim")
    with pytest.raises(ValueError, match="gateway"):
        DockerConfig(docker_host="tcp://sockguard:2375", image=IMAGE, gateway_host="gateway")


def test_a_tag_is_accepted_only_when_the_operator_says_their_own_build_made_it():
    cfg = DockerConfig(docker_host="tcp://sockguard:2375", image="alpha-selfhost-agent:latest", allow_tag=True)
    assert cfg.image == "alpha-selfhost-agent:latest"


def test_a_run_code_sandbox_is_created_hardened_with_no_network():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    (_, (image,), k), = api.called("create_container")
    assert image == IMAGE
    assert k["user"] == "1000:1000"
    assert k["name"] == "alpha-sbx-" + key_for("alice", "conv1")
    hc = k["host_config"]
    assert hc["Privileged"] is False
    assert hc["CapDrop"] == ["ALL"]
    assert hc["SecurityOpt"] == ["no-new-privileges:true"]
    assert hc["ReadonlyRootfs"] is True
    assert hc["NetworkMode"] == "none"
    assert hc["Memory"] == hc["MemorySwap"] == 1024 * 1024 * 1024
    assert hc["NanoCpus"] == 1_000_000_000
    assert hc["PidsLimit"] == 256
    assert hc["Init"] is False  # PID 1 is ours, started under env -i, so no image ENV is readable from /proc/1
    assert k["entrypoint"][:2] == ["env", "-i"]
    assert "size=512m" in hc["Tmpfs"]["/home/user"] and "uid=1000" in hc["Tmpfs"]["/home/user"]
    # Nothing from the host: no bind, mount, device or added capability key at all.
    for key in ("Binds", "Mounts", "Devices", "CapAdd", "PidMode", "IpcMode", "UsernsMode", "VolumesFrom"):
        assert key not in hc
    assert not api.called("create_network")
    assert h.tier is Tier.RUN_CODE and h.ref == "c-" + k["name"]
    # The workspace is made, as the sandbox user, before the handle is returned.
    assert api.execs["e0"]["user"] == "1000:1000"
    assert api.execs["e0"]["cmd"][-3:] == ["mkdir", "-p", WORK]
    # From the home directory: Docker refuses an exec whose working directory does not exist yet.
    assert api.execs["e0"]["workdir"] == "/home/user"


def test_limits_come_from_config():
    b, api = backend(cpus=0.5, memory_mb=256, pids=64, tmpfs_mb=100)
    b.connect("alice", "conv1", Tier.RUN_CODE)
    hc = api.called("create_container")[0][2]["host_config"]
    assert (hc["NanoCpus"], hc["Memory"], hc["PidsLimit"]) == (500_000_000, 256 * 1024 * 1024, 64)
    assert "size=100m" in hc["Tmpfs"]["/home/user"]


def test_an_agent_sandbox_gets_an_internal_network_of_its_own_with_only_the_gateway():
    b, api = backend()
    b.connect("alice", "conv1", Tier.AGENT)
    net = "alpha-sbx-" + key_for("alice", "conv1")
    (_, (name,), k), = api.called("create_network")
    assert name == net and k["internal"] is True
    (_, (container, joined), ck), = api.called("connect_container_to_network")
    assert (container, joined, ck["aliases"]) == ("alpha-agent-proxy-1", net, ["gateway"])
    assert api.called("create_container")[0][2]["host_config"]["NetworkMode"] == net


def test_an_agent_sandbox_with_no_gateway_configured_has_no_network():
    b, api = backend(gateway_host="", gateway_container="")
    b.connect("alice", "conv1", Tier.AGENT)
    assert api.called("create_container")[0][2]["host_config"]["NetworkMode"] == "none"
    assert not api.called("create_network")


def test_connect_finds_the_running_sandbox_by_name_instead_of_making_another():
    b, api = backend()
    first = b.connect("alice", "conv1", Tier.RUN_CODE)
    again = b.connect("alice", "conv1", Tier.RUN_CODE)
    assert again.ref == first.ref and len(api.called("create_container")) == 1
    other = b.connect("alice", "conv2", Tier.RUN_CODE)
    assert other.ref != first.ref


def test_a_sandbox_made_for_another_tier_is_refused():
    b, _api = backend()
    b.connect("alice", "conv1", Tier.RUN_CODE)
    with pytest.raises(SandboxError, match="another tier"):
        b.find("alice", "conv1", Tier.AGENT)


def test_a_stopped_sandbox_is_removed_and_replaced_since_its_tmpfs_is_gone():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    next(i for i in api.containers_by_name.values() if i["Id"] == h.ref)["State"] = {"Running": False}
    assert b.find("alice", "conv1", Tier.RUN_CODE) is None
    assert api.called("remove_container")


def test_a_name_conflict_from_a_racing_create_uses_the_winner():
    b, api = backend()
    name = "alpha-sbx-" + key_for("alice", "conv1")
    real_inspect = api.inspect_container
    seen = []

    def inspect(n):
        seen.append(n)
        if len(seen) == 1:
            raise ApiError(404)  # not there when looked for...
        return real_inspect(n)
    api.inspect_container = inspect
    api.containers_by_name[name] = {"Id": "winner", "Config": {"Labels": {}}, "State": {"Running": True},
                                    "Created": 1, "Labels": {}}
    h = b.connect("alice", "conv1", Tier.RUN_CODE)  # ...then made by someone else first
    assert h.ref == "winner"


def test_the_proxy_being_down_is_a_worded_error():
    b, api = backend()
    api.fail_inspect = ApiError(502, "bad gateway")
    with pytest.raises(SandboxError, match="can't be reached"):
        b.connect("alice", "conv1", Tier.RUN_CODE)


def test_a_refused_create_is_a_worded_error():
    b, api = backend()
    api.create_container = lambda *a, **k: (_ for _ in ()).throw(ApiError(403, "request denied by sockguard policy"))
    with pytest.raises(SandboxError, match="could not be started"):
        b.connect("alice", "conv1", Tier.RUN_CODE)


def test_destroy_removes_the_container_and_its_network():
    b, api = backend()
    b.connect("alice", "conv1", Tier.AGENT)
    net = "alpha-sbx-" + key_for("alice", "conv1")
    assert b.destroy("alice", "conv1") == 1
    assert api.called("remove_container")[0][2]["force"] is True
    assert api.called("disconnect_container_from_network")[0][1] == ("alpha-agent-proxy-1", net)
    assert net not in api.networks_by_name and not api.containers_by_name
    assert b.destroy("alice", "conv1") == 0


def test_reap_removes_every_sandbox_and_network_left_by_an_earlier_process():
    b, api = backend()
    b.connect("alice", "conv1", Tier.AGENT)
    b.connect("bob", "conv2", Tier.RUN_CODE)
    api.networks_by_name["alpha-sbx-orphan"] = {"Name": "alpha-sbx-orphan"}
    fresh, _ = backend(api)
    assert fresh.reap() == 2
    assert not api.containers_by_name and not api.networks_by_name
    assert api.called("containers")[0][2]["filters"] == {"label": ["org.aipotluck.sandbox=1"]}


def test_sweep_removes_only_sandboxes_unused_past_the_limit_and_never_a_kept_one():
    b, api = backend()
    clock = [10_000.0]
    b._clock = lambda: clock[0]
    b.connect("alice", "old", Tier.RUN_CODE)
    b.connect("alice", "kept", Tier.AGENT)
    clock[0] += 500
    b.connect("alice", "new", Tier.RUN_CODE)
    killed = b.sweep(300, keep=frozenset({key_for("alice", "kept")}))
    assert killed == [key_for("alice", "old")]
    # An agent sandbox goes past the shorter running limit unless kept.
    assert b.sweep(10_000, running_older_than_secs=100) == [key_for("alice", "kept")]


def test_pause_keeps_the_sandbox_and_attach_cannot_reconnect():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    b.pause(h)
    assert not api.called("remove_container")
    with pytest.raises(CannotAttach):
        b.attach(h, "e1")


def test_exec_runs_as_the_sandbox_user_under_a_timeout_and_reports_the_exit():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    api.exec_answer = lambda argv: (b"hi\n", b"warn\n", 3)
    r = b.exec(h, ["python3", "-c", "print('hi')"], 20)
    assert (r.stdout, r.stderr, r.code, r.timed_out) == ("hi\n", "warn\n", 3, False)
    last = api.execs[f"e{len(api.execs) - 1}"]
    t = last["cmd"].index("timeout")
    assert last["cmd"][:2] == ["env", "-i"] and "HOME=/home/user" in last["cmd"][:t]
    assert last["cmd"][t:t + 4] == ["timeout", "-s", "KILL", "20"]
    assert last["cmd"][-1] == "python3 -c 'print('\"'\"'hi'\"'\"')'"
    assert last["user"] == "1000:1000" and last["workdir"] == WORK


def test_exec_past_its_timeout_reads_as_timed_out(monkeypatch):
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    api.exec_answer = lambda argv: (b"", b"", 137)
    t = iter([0.0, 5.0])
    monkeypatch.setattr("sandbox_docker.time.monotonic", lambda: next(t))
    r = b.exec(h, ["sleep", "60"], 5)
    assert r.timed_out and r.code is None


def test_read_and_write_go_through_exec_and_stay_inside_the_workspace():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    written: list[bytes] = []

    def answer(argv):
        script = argv[-1] if "timeout" in argv else ""
        if script.startswith("realpath"):
            target = script.split(" -- ")[-1].strip("'")
            return target.encode() + b"\n", b"", 0
        if "base64 -d" in script:
            written.append(base64.b64decode(script.split()[-2].strip("'")))
            return b"", b"", 0
        if "head -c" in script:
            return base64.b64encode(b"".join(written)), b"", 0
        return b"", b"", 0
    api.exec_answer = answer
    data = b"x" * (48 * 1024 + 10)
    b.write(h, "out/data.csv", data)
    assert b"".join(written) == data and len(written) == 2  # chunked under the one-argument cap
    assert b.read(h, "out/data.csv", 5) == b"xxxxx"
    with pytest.raises(SandboxError, match="outside"):
        b.read(h, "../../etc/passwd", 10)
    with pytest.raises(SandboxError, match="outside"):
        b.write(h, "/etc/passwd", b"")


def test_a_link_resolving_outside_the_workspace_is_refused():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    api.exec_answer = lambda argv: (b"/etc/passwd\n", b"", 0)
    with pytest.raises(SandboxError, match="outside"):
        b.read(h, "link", 10)


def test_list_parses_find_output():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.RUN_CODE)
    api.exec_answer = lambda argv: (b"b.txt\t3\x1ea.csv\t10\x1e.stdin\t1\x1e", b"", 0)
    assert b.list(h, 10) == [("a.csv", 10), ("b.txt", 3)]


def _frame(stream: int, data: bytes) -> bytes:
    return bytes([stream, 0, 0, 0]) + struct.pack(">I", len(data)) + data


def test_frames_splits_docker_multiplexed_output():
    a, z = socket.socketpair()
    a.sendall(_frame(1, b"out") + _frame(2, b"err") + _frame(1, b""))
    a.close()
    assert list(frames(z)) == [(1, b"out"), (2, b"err"), (1, b"")]


def test_open_stdio_bridges_the_exec_socket_and_kills_the_process_on_exit():
    b, api = backend()
    h = b.connect("alice", "conv1", Tier.AGENT)
    ours, theirs = socket.socketpair()

    def exec_start(eid, demux=False, socket=False):
        if socket:
            return theirs
        out, err, code = api.exec_answer(api.execs[eid]["cmd"])
        api.execs[eid]["ExitCode"] = code
        return out, err
    api.exec_start = exec_start

    async def run():
        async with b.open_stdio(h, ["kilo", "acp"], {"HF_TOKEN": "nonce"}) as (reader, writer, proc):
            ours.sendall(_frame(1, b'{"jsonrpc":"2.0"}\n') + _frame(2, b"log line\n"))
            assert await asyncio.wait_for(reader.readline(), 5) == b'{"jsonrpc":"2.0"}\n'
            assert await asyncio.wait_for(proc.stderr.readline(), 5) == b"log line\n"
            writer.write(b"request\n")
            await writer.drain()
            got = await asyncio.to_thread(ours.recv, 100)
            assert got == b"request\n"
        return proc

    proc = asyncio.run(run())
    stdio = next(e for e in api.execs.values() if e.get("stdin"))
    assert stdio["cmd"][-2:] == ["kilo", "acp"] and "HF_TOKEN=nonce" in stdio["cmd"]
    assert stdio["cmd"][:2] == ["env", "-i"]  # nothing from the image's own environment
    assert stdio["user"] == "1000:1000"
    kills = [e for e in api.execs.values() if "kill -KILL" in e["cmd"][-1]]
    assert kills, "leaving the block kills the process"
    ours.close()
    assert proc is not None

