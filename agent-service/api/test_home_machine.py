"""A conversation's sandbox calls, file downloads and first agent turn reach one home machine (CUR-4435).

The MCP face's own replay case lives in test_sandbox_mcp.py, which owns the one MCP session manager a test
process may run; this file covers the routing rule itself and the two plain HTTP routes.
"""

import app
import home_machine
import pytest
from fastapi.testclient import TestClient

IDS = ("m-aaaa", "m-bbbb")
AUTH = {"x-agent-account": "user"}


def _other(conv):
    home = home_machine.home_for(conv, IDS)
    return next(m for m in IDS if m != home), home


def test_every_machine_computes_the_same_home_and_conversations_spread():
    homes = {home_machine.home_for(f"conv-{i}", IDS) for i in range(64)}
    assert homes == set(IDS)  # both machines are home to some conversations
    assert home_machine.home_for("conv-7", IDS) == home_machine.home_for("conv-7", tuple(reversed(IDS)))


def test_a_new_machine_moves_only_the_conversations_it_becomes_home_to():
    convs = [f"conv-{i}" for i in range(200)]
    before = {c: home_machine.home_for(c, IDS) for c in convs}
    after = {c: home_machine.home_for(c, (*IDS, "m-cccc")) for c in convs}
    assert all(after[c] in (before[c], "m-cccc") for c in convs)


def test_a_request_on_the_wrong_machine_is_replayed_to_the_home_and_served_at_home():
    other, home = _other("conv-1")
    assert home_machine.replay_target("conv-1", {}, self_id=other, ids=IDS) == home
    assert home_machine.replay_target("conv-1", {}, self_id=home, ids=IDS) is None


@pytest.mark.parametrize("headers", [{"fly-replay-src": "instance=x"}, {"fly-force-instance-id": "m-aaaa"}])
def test_a_replayed_or_pinned_request_is_served_where_it_lands(headers):
    other, _ = _other("conv-1")
    assert home_machine.replay_target("conv-1", headers, self_id=other, ids=IDS) is None


def test_a_body_too_large_for_fly_to_replay_is_served_where_it_lands():
    other, home = _other("conv-1")
    fits = {"content-length": str(home_machine.REPLAY_MAX_BYTES)}
    too_big = {"content-length": str(home_machine.REPLAY_MAX_BYTES + 1)}
    assert home_machine.replay_target("conv-1", fits, self_id=other, ids=IDS) == home
    assert home_machine.replay_target("conv-1", too_big, self_id=other, ids=IDS) is None


@pytest.mark.parametrize(
    ("conv", "self_id", "ids"),
    [
        (None, "m-aaaa", IDS),  # no conversation named
        ("conv-1", None, IDS),  # not on Fly
        ("conv-1", "m-aaaa", ("m-aaaa",)),  # one machine
        ("conv-1", "m-zzzz", IDS),  # our id is missing from a stale list
    ],
)
def test_anything_short_of_two_known_machines_serves_locally(conv, self_id, ids):
    assert home_machine.replay_target(conv, {}, self_id=self_id, ids=ids) is None


def test_the_machine_list_is_read_from_the_root_written_file(tmp_path):
    f = tmp_path / "machines"
    f.write_text("m-bbbb\nm-aaaa\n\n")
    assert home_machine.machine_ids(str(f)) == IDS
    assert home_machine.machine_ids(str(tmp_path / "absent")) == ()


@pytest.fixture
def on_wrong_machine(monkeypatch):
    def place(conv):
        other, home = _other(conv)
        monkeypatch.setattr(app, "FLY_MACHINE_ID", other)
        monkeypatch.setattr(home_machine, "machine_ids", lambda *a, **k: IDS)
        return home

    monkeypatch.setattr(app, "AUTH_DISABLED", True)
    return place


def test_an_artifact_download_on_the_wrong_machine_is_replayed_home(on_wrong_machine):
    home = on_wrong_machine("conv-9")
    r = TestClient(app.app).get("/sessions/conv-9/artifacts/out.csv", headers=AUTH)
    assert r.status_code == 204
    assert r.headers["fly-replay"] == f"prefer_instance={home}"


def test_a_first_agent_turn_on_the_wrong_machine_is_replayed_home(on_wrong_machine):
    home = on_wrong_machine("conv-9")
    r = TestClient(app.app).post("/run", headers=AUTH, json={"prompt": "hi", "session_id": "conv-9"})
    assert r.status_code == 204
    assert r.headers["fly-replay"] == f"prefer_instance={home}"


def test_the_machine_ids_are_read_from_fly_vms_txt_record():
    assert home_machine.parse_vms_txt("1859655cd075d8 fra,80e9749f642528 fra") == ["1859655cd075d8", "80e9749f642528"]
    assert home_machine.parse_vms_txt("80e9749f642528 fra") == ["80e9749f642528"]
    assert home_machine.parse_vms_txt("") == []


def test_the_writer_replaces_the_file_with_the_ids_dns_lists(tmp_path, monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "potluck-agent-test")
    monkeypatch.setattr(home_machine, "_list_from_dns", lambda app_name: ["m-aaaa", "m-bbbb"])
    f = tmp_path / "machines"
    assert home_machine.write(str(f)) == 0
    assert home_machine.machine_ids(str(f)) == IDS


def test_a_failed_dns_read_keeps_the_last_good_file(tmp_path, monkeypatch):
    monkeypatch.setenv("FLY_APP_NAME", "potluck-agent-test")

    def refuse(app_name):
        raise OSError("resolver unreachable")

    monkeypatch.setattr(home_machine, "_list_from_dns", refuse)
    f = tmp_path / "machines"
    f.write_text("m-aaaa\nm-bbbb\n")
    assert home_machine.write(str(f)) == 1
    assert home_machine.machine_ids(str(f)) == IDS
