#!/usr/bin/env python3
"""Offline unit tests for the ACP↔HTTP shim (api/acp_remote.py).

This surface forwards prompts to the hosted service over HTTP and runs nothing locally, so its pure
helpers (content-block flattening, per-user JWT header) get the same regression coverage as the HTTP
path. The stdio JSON-RPC `main()` loop and the live HTTP forwarding need a real ACP client + a
running service, so they're exercised by the bash integration tests, not here.

Importing this module pulls in `agent-client-protocol` (a dev dep; in production it lives in the
Hermes venv).
"""
import types

import acp_remote


# --------------------------------------------------------------------------- _prompt_text
def test_acp_prompt_text_flattening():
    """Flatten ACP content blocks: objects with .text and dict blocks both work; empties dropped."""
    blocks = [
        types.SimpleNamespace(text="first"),         # object-with-.text (the acp schema block)
        {"text": "second"},                          # dict block
        types.SimpleNamespace(text=None),            # no text -> skipped
        {"type": "image"},                           # non-text dict -> skipped
        {"text": ""},                                # empty -> skipped
    ]
    assert acp_remote._prompt_text(blocks) == "first\nsecond", "flattens text blocks, joins with newline"
    assert acp_remote._prompt_text([]) == "", "no blocks -> empty string"
    assert acp_remote._prompt_text(None) == "", "None blocks -> empty string"


# --------------------------------------------------------------------------- acp_remote._headers
def test_acp_remote_headers():
    """The shim carries only the caller's per-user JWT — never the upstream token or admin key."""
    _saved = acp_remote.TOKEN
    try:
        acp_remote.TOKEN = "user-jwt-abc"
        h = acp_remote._headers()
        assert h["content-type"] == "application/json", "content-type always set"
        assert h["authorization"] == "Bearer user-jwt-abc", "carries the per-user JWT when present"
        acp_remote.TOKEN = ""
        h2 = acp_remote._headers()
        assert "authorization" not in h2, "no token -> no authorization header (anonymous request)"
        assert h2["content-type"] == "application/json", "content-type still set without a token"
    finally:
        acp_remote.TOKEN = _saved


# --------------------------------------------------------------------------- _KIND mapping
def test_acp_kind_mapping():
    """Step kind -> ACP ToolKind badge (falls back to 'other' for an unrecognized kind)."""
    assert acp_remote._KIND == {"tool": "execute", "write": "edit", "read": "read", "compute": "think"}, \
        "acp_remote step-kind -> ToolKind map"
