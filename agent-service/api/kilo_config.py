"""Kilo's launch config for one agent attempt: the config file, the process environment, the `kilo acp` argv,
the mapping from our approval policy onto Kilo's per-action allow / ask / deny, and the one permission option
we ever select.

Not wired to any run yet: hosted agent mode still drives its current engine, and the switch is gated on the
Kilo eval run. Its own module, with no `acp` import, so it can be tested with no Kilo binary and no ACP package.
Everything here is pure except `write_config`.

Kilo is Kilo-Org/kilocode (MIT). The source references below are to its packages/ tree."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

# Kilo's provider id for our gateway. Our own name, so it can never collide with a provider Kilo ships.
KILO_PROVIDER_ID = "potluck"

# Permission keys Kilo knows (kilocode packages/core/src/v1/config/permission.ts), sorted by what they can do.
# Read-only tools run without asking: they change nothing, and the sandbox bounds what they can see.
_KILO_READ_ONLY = ("read", "glob", "grep", "list", "lsp", "todowrite", "notebook_read")
# Tools that write a file or run code. These reach request_permission as kind "edit" or "execute"
# (`toToolKind`), where our approval policy decides; under deny_writes Kilo refuses them itself.
_KILO_WRITES = ("edit", "bash", "notebook_edit", "notebook_execute")
# Tools agent mode does not offer. The sandbox has no route to the web, there is nobody to answer a
# question mid-task, subagents (and the board they share) would run outside this session's tool accounting,
# skills, the agent manager and markdown sources load instructions from outside the task, and memory would
# carry one task's content into another. doom_loop is the permission Kilo asks when the model repeats one call
# three times; denying it stops the loop instead of granting a fourth try. Kilo's own `code` agent already
# denies several of these (suggest, plan_*, repo_*), but our catch-all comes after its rules and would turn
# them back into asks, so they are named here too (`kilo debug agent code` lists the merged rules).
_KILO_NEVER = ("webfetch", "websearch", "codesearch", "repo_clone", "repo_overview", "question", "suggest",
               "plan_enter", "plan_exit", "task", "board_read", "board_post", "skill", "agent_manager",
               "markdown_source", "recall", "kilo_memory_recall", "kilo_memory_save", "doom_loop")


def kilo_permissions(permission_policy: str, connector_names: tuple[str, ...] | list[str] = ()) -> dict[str, str]:
    """Kilo's `permission` block for one resolved policy (allow / confirm / deny_writes).

    Order is the contract: Kilo evaluates rules in config order and the LAST match wins, so the catch-all comes
    first and every named rule after it overrides it. The catch-all is `ask` (deny under deny_writes), never
    `allow`: a tool this map does not name — a tool a later Kilo adds, an MCP tool — reaches request_permission
    and is decided there, and Kilo itself rejects an ask the client does not answer.

    `external_directory` (a path outside the session folder) asks, rather than being denied, because the sandbox
    is what contains files: a shell command that writes to /tmp would otherwise fail inside a task that the
    person approved.

    `connector_names` are the turn owner's own connectors, which the gateway relays read-only tools for and refuses
    the rest (mcp_relay.py). Kilo names an MCP tool `<server>_<tool>`, so `<name>_*` lets those run without a card
    under allow and confirm: nobody is watching an agent turn to answer one, and the read-only rule is enforced
    where the engine cannot reach. Under deny_writes they are denied with everything else."""
    deny_writes = permission_policy == "deny_writes"
    perms: dict[str, str] = {"*": "deny" if deny_writes else "ask"}
    for key in _KILO_READ_ONLY:
        perms[key] = "allow"
    for key in _KILO_WRITES:
        perms[key] = "deny" if deny_writes else "ask"
    perms["external_directory"] = "deny" if deny_writes else "ask"
    for name in connector_names:
        perms[f"{name}_*"] = "deny" if deny_writes else "allow"
    for key in _KILO_NEVER:
        perms[key] = "deny"
    return perms


def kilo_config(model: str, base_url: str, permission_policy: str, *,
                context_tokens: int = 128_000, output_tokens: int = 16_384,
                connector_names: tuple[str, ...] | list[str] = ()) -> dict:
    """The whole Kilo config for one attempt: our OpenAI-compatible gateway as the only provider, the task's
    model, the policy's permissions, and every feature that would reach a Kilo service turned off.

    The API key is `{env:HF_TOKEN}`, which Kilo substitutes from the process environment when it loads a global
    config, so the task's gateway nonce is never written to disk. `enabled_providers` names only our gateway,
    which leaves Kilo's own gateway, and every provider that would need a Kilo or vendor account, unloaded."""
    if not model:
        raise ValueError("agent mode needs a model: set AGENT_MODEL or pass the task's model")
    if not base_url:
        raise ValueError("agent mode needs the model gateway's base URL (HF_BASE_URL or AGENT_MODEL_BASE_URL)")
    ref = f"{KILO_PROVIDER_ID}/{model}"
    return {
        "model": ref,
        "small_model": ref,
        "enabled_providers": [KILO_PROVIDER_ID],
        "provider": {KILO_PROVIDER_ID: {
            "name": "AI Potluck model gateway",
            "npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": base_url, "apiKey": "{env:HF_TOKEN}"},
            "models": {model: {"name": model, "tool_call": True,
                               "limit": {"context": context_tokens, "output": output_tokens}}},
        }},
        "permission": kilo_permissions(permission_policy, connector_names),
        "share": "disabled",
        "autoupdate": False,
        "snapshot": False,
        "lsp": False,
        "formatter": False,
        "remote_control": False,
        # Session titles are a side call nobody sees in agent mode; one fewer request against the grant.
        "agent": {"title": {"disable": True}},
    }


def kilo_env(agent_home: str) -> dict[str, str]:
    """Process environment that keeps Kilo inside `agent_home` and off the network except for our gateway.

    `agent_home` is the attempt's home as the agent process sees it (the guest path on a remote sandbox). HOME
    and every XDG base dir point into it, so Kilo's config, sessions and caches are per attempt and a dotfile
    planted by an earlier turn is not read by the next. KILO_DISABLE_PROJECT_CONFIG stops Kilo reading a
    kilo.json, .kilo/ directory or instructions file the agent may have written into the session folder, which would
    otherwise let a task rewrite its own permissions. KILO_SERVER_PASSWORD is fresh per attempt: `kilo acp`
    serves its session over HTTP on 127.0.0.1, and on a shared host without it any local process could answer
    this session's permission requests."""
    home = agent_home.rstrip("/")
    return {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/config",
        "XDG_DATA_HOME": f"{home}/data",
        "XDG_CACHE_HOME": f"{home}/cache",
        "XDG_STATE_HOME": f"{home}/state",
        "KILO_DISABLE_PROJECT_CONFIG": "1",
        "KILO_DISABLE_AUTOUPDATE": "1",
        "KILO_DISABLE_MODELS_FETCH": "1",
        "KILO_DISABLE_LSP_DOWNLOAD": "1",
        "KILO_DISABLE_DEFAULT_PLUGINS": "1",
        "KILO_DISABLE_CLAUDE_CODE": "1",
        "KILO_DISABLE_EXTERNAL_SKILLS": "1",
        "KILO_TELEMETRY_LEVEL": "off",
        "KILO_SERVER_PASSWORD": uuid.uuid4().hex,
    }


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return value if value > 0 else default


def write_config(attempt_home: str, model: str, base_url: str, permission_policy: str,
                 connector_names: tuple[str, ...] | list[str] = ()) -> Path:
    """Write the attempt's Kilo config as Kilo's global config (`<home>/config/kilo/kilo.json`, which is where
    XDG_CONFIG_HOME from `kilo_env` points it). Returns the path. Written whole each attempt, never merged:
    the attempt home is new for every attempt (app.py names it by task id and attempt number)."""
    cfg = kilo_config(model, base_url, permission_policy,
                      context_tokens=_env_int("AGENT_MODEL_CONTEXT_TOKENS", 128_000),
                      output_tokens=_env_int("AGENT_MODEL_OUTPUT_TOKENS", 16_384),
                      connector_names=connector_names)
    path = Path(attempt_home, "config", "kilo", "kilo.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    # The session folder outlives a turn and the agent can write it, and this runs outside the sandbox, so a
    # symlink planted where the config goes must never carry the write out.
    for p in (Path(attempt_home), path.parent.parent, path.parent):
        if p.is_symlink():
            raise PermissionError(f"refusing to write Kilo's config through a symlink: {p}")
    if path.is_symlink() or (path.exists() and not path.is_file()):
        path.unlink()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(cfg, indent=2) + "\n")
    return path


def kilo_argv(sandbox_prefix: list[str], kilo_bin: str) -> tuple[str, list[str]]:
    """(command, args) for `spawn_agent_process`, with any sandbox launcher in front. `--pure` starts Kilo
    without external plugins, so nothing is fetched from npm at startup and only Kilo's own tools run."""
    tail = [kilo_bin, "acp", "--pure"]
    if sandbox_prefix:
        return sandbox_prefix[0], [*sandbox_prefix[1:], *tail]
    return tail[0], tail[1:]


def pick_option(options, allow: bool) -> str:
    """The PermissionOption id that answers this ONE call.

    An allow is always `allow_once`, never `allow_always`: Kilo stores an "always" reply as a session rule and
    stops asking for matching calls (packages/opencode/src/acp/permission.ts), which would let later calls past
    our approval cards unseen. When no allow_once option is offered the answer is a reject, so a changed option
    list fails closed rather than widening. A reject prefers `reject_once`, then any reject kind, and with no
    reject offered returns "reject", which Kilo reads as a refusal because it is neither "once" nor "always"."""
    kinds = [(str(getattr(o, "kind", "")), getattr(o, "option_id", "")) for o in options or []]
    if allow:
        for kind, oid in kinds:
            if kind == "allow_once":
                return oid
    for kind, oid in sorted(kinds, key=lambda k: k[0] != "reject_once"):
        if kind.startswith("reject"):
            return oid
    return "reject"
