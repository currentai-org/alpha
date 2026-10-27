"""CUR-3025, live: a real `hermes acp` session calls two tools on a stub MCP server.

Skipped unless AGENT_MCP_LIVE_HERMES_PY names a Python that has the pinned Hermes installed with the
`[acp,mcp]` extras (the offline suite's venv has neither Hermes nor `mcp`). Everything runs on loopback
with a scripted model, so it costs nothing; see scripts/mcp_live_probe.py for what it drives.

    AGENT_MCP_LIVE_HERMES_PY=/path/to/hermes/.venv/bin/python .venv/bin/python -m pytest api/test_mcp_hermes_live.py
"""
import os
import subprocess as sp
from pathlib import Path

import pytest

PY = os.environ.get("AGENT_MCP_LIVE_HERMES_PY", "")
PROBE = Path(__file__).resolve().parent.parent / "scripts" / "mcp_live_probe.py"

pytestmark = pytest.mark.skipif(not PY, reason="AGENT_MCP_LIVE_HERMES_PY unset: no Hermes with [acp,mcp] here")


def _probe(tmp_path, *args):
    return sp.run([PY, str(PROBE), "--tmp", str(tmp_path), *args], capture_output=True, text=True, timeout=240)


def test_a_hermes_session_calls_two_mcp_tools_and_answers_from_their_results(tmp_path):
    r = _probe(tmp_path)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-2000:]
    assert "RESULT=50" in r.stdout


def test_without_mcp_servers_on_new_session_the_same_run_fails(tmp_path):
    """The injury: identical run, no servers passed. If this ever passes, the test above proves nothing."""
    r = _probe(tmp_path, "--no-mcp")
    assert r.returncode == 1, r.stdout[-3000:]
    assert "NO_MCP_TOOLS_OFFERED" in r.stdout
