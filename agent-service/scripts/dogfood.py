#!/usr/bin/env python3
"""Local dogfood harness — drive the REAL service end-to-end against a real upstream.

Boots `proxy` + `app` exactly like the shipped stack
(same boundary: proxy holds the token, app is credential-free, per-task nonce + caps +
sandbox), submits ONE task to `/run`, polls to completion, and prints the result + the
service's own deterministic `verified` verdict — the "watch it actually work" smoke test.

Modes:
  apertus15  the shipped default — Apertus-1.5-70B driving Hermes' real multi-turn loop, the
             `coding` toolset, best-of-3. Needs a verify spec for best-of-N to engage (it can't
             pick a winner it can't check). Upstream: the real LiteLLM gateway prod routes
             through (CUR-189), the same path `MODEL_PROVIDERS=gateway` selects in the deployed
             proxy — not CSCS direct, which prod's real config only ever reaches via a one-line
             manual rollback (the deployed gateway's `MODEL_PROVIDERS`), never live
             failover. Needs PROVIDER_GATEWAY_BASE and PROVIDER_GATEWAY_TOKEN set.
  mistral    Mistral-Small-4-119B — kept as the comparison baseline the CUR-27 numbers are
             measured against. Upstream: Infomaniak.
  qwen       Qwen3.5-122B — the reliable open-WEIGHT fallback/sanity-check comparison. Verify
             spec optional (only sets the `verified` flag). Upstream: Infomaniak.

The interactive Qwen TUI (`hermes --tui`) is a separate, genuinely-interactive surface and is
not wrapped here — it needs a TTY and its own config.

Usage:
  python dogfood.py apertus15
  python dogfood.py qwen "Using the terminal tool only: list the .txt files here and write the count to n.txt"
  python dogfood.py apertus15 "<task>" --expect-file r.txt --expect-contains 3
  python dogfood.py mistral
  (IK_TOKEN defaults to the gitignored Infomaniak token file; PROVIDER_CSCS_TOKEN has no such
  fallback file — set it in the environment. Never printed either way.)
"""
import argparse
import atexit
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]              # agent-service/
API = ROOT / "api"
def _first_venv_bin(name: str, override: str) -> str:
    """A venv executable, from $override if set, else the first checkout that actually has one.

    A single hardcoded `~/hermes-agent/.venv/bin/...` path may not exist on the machine this harness runs
    on, and a bare run would then fail at spawn time with a bare ENOENT. Listing the real candidates makes
    the failure legible and lets a patched checkout be selected by its own path rather than by exporting
    HERMES_BIN."""
    if override:
        return override
    homes = [Path.home() / "Documents/hermes-agent", Path.home() / "hermes-agent"]
    for h in homes:
        p = h / ".venv/bin" / name
        if p.exists():
            return str(p)
    return f"<no {name} venv found in: {', '.join(str(h) for h in homes)}>"


# HERMES_BIN selects the executor binary, and a measurement arm that patches Hermes sets it to that
# checkout's venv. Keep the patch on the SAME base the Dockerfile pins (deploy/Dockerfile clones upstream
# at a pinned SHA), or an arm silently tests more than one patch at once.
PY = _first_venv_bin("python", os.environ.get("PYBIN", ""))
HERMES = _first_venv_bin("hermes", os.environ.get("HERMES_BIN", ""))

IK_PRODUCT_ID = os.environ.get("IK_PRODUCT_ID", "109376")
INFOMANIAK_BASE = os.environ.get("MODEL_UPSTREAM_BASE", f"https://api.infomaniak.com/2/ai/{IK_PRODUCT_ID}/openai/v1")
PPORT = int(os.environ.get("PPORT", "8752"))            # distinct from passk (8742) so both can run
APORT = int(os.environ.get("APORT", "8751"))
ADMIN = os.environ.get("PROXY_ADMIN_KEY", "dogfoodadmin")
CAP = int(os.environ.get("AGENT_MAX_STEPS", "12"))
WALL = int(os.environ.get("AGENT_WALL_CLOCK_SECS", "240"))
# Prod sets a real 60k spend cap. Without a token ceiling here, one runaway trial can
# burn several hundred thousand tokens before the wall-clock stops it, so mirror prod's guardrail and keep
# local runs inside what a production task could spend.
TOKEN_CAP = int(os.environ.get("AGENT_MAX_TOKENS", "60000"))

# Per mode: model id + upstream (base/token/name) + the env that selects the toolset/best-of config.
# provider=huggingface is just the OpenAI-compatible wire format every upstream here speaks; the proxy
# rewrites the base to `base`.
MODES = {
    "apertus15": {
        # Goes through the gateway, the path prod takes. The deployed proxy's compute-router
        # (`_load_providers`, api/proxy.py) reads an ORDERED `MODEL_PROVIDERS` list, and the deployed value
        # is `MODEL_PROVIDERS = "gateway"`, a single entry. CSCS is not a live failover partner:
        # the deployed gateway config keeps it as a manual rollback (put cscs back in MODEL_PROVIDERS and
        # deploy), so a CSCS-direct mode would test a path prod doesn't take. The model id below is the
        # gateway catalog alias (prod's AGENT_MODEL), so a rate limit on this model group
        # shows up here as it would in prod.
        "model": "swiss-ai/apertus-v1.5-70b",
        "env": {"AGENT_TOOLSETS": "coding", "AGENT_BEST_OF": "3"},
        "blurb": "shipped default · real Hermes loop + coding toolset + best-of-3 · via the real LiteLLM gateway prod uses, matching MODEL_PROVIDERS=gateway",
        "base": os.environ.get("PROVIDER_GATEWAY_BASE", ""), "token_env": "PROVIDER_GATEWAY_TOKEN",
        "upstream_name": "LiteLLM gateway",
    },
    "apertus15-8b": {
        # A CONTROL, not a candidate. Same family, same endpoint, ~9x smaller — the point is to check
        # that an eval discriminates at all. If a tier scores the 8B near the 70B, the tier is measuring
        # the harness rather than the model and its headline number should not be trusted. Also on the
        # durable k8s tier (CSCS's durable tier), so it won't rotate out mid-comparison.
        # CSCS-direct on purpose here (unlike apertus15 above, which goes through the gateway) — this is
        # a raw-catalog discriminating-power check, not a claim about prod's routing. The wire id has
        # changed namespace before; check_model_live() below turns the next such change into a loud
        # failure instead of a confusing mid-run one.
        "model": "CSCS-Inference/swiss-ai/Apertus-v1.5-8B",
        "env": {"AGENT_TOOLSETS": "coding", "AGENT_BEST_OF": "3"},
        "blurb": "CONTROL — 8B sibling of the shipped 70B · run to confirm an eval has discriminating power",
        "base": os.environ.get("PROVIDER_CSCS_BASE", ""), "token_env": "PROVIDER_CSCS_TOKEN",
        "upstream_name": "CSCS (preview)",
    },
    "mistral": {
        "model": "mistralai/Mistral-Small-4-119B-2603",
        "env": {"AGENT_TOOLSETS": "coding", "AGENT_BEST_OF": "3"},
        "blurb": "prior shipped default (through 2026-07-24) · the baseline CUR-27 numbers are measured against",
        "base": INFOMANIAK_BASE, "token_env": "IK_TOKEN", "upstream_name": "Infomaniak",
    },
    "qwen": {
        "model": "Qwen/Qwen3.5-122B-A10B-FP8",
        "env": {},
        "blurb": "open-weight · reliable stock — fallback sanity-check only",
        "base": INFOMANIAK_BASE, "token_env": "IK_TOKEN", "upstream_name": "Infomaniak",
    },
}

# Bounded + verifiable default task. Pass = the service's _verify reads real file state (r.txt contains '3').
DEFAULT_TASK = ("Using the terminal tool only: create three files named a.py, b.py and c.py in the "
                "current directory, then count the .py files there and write just that integer to "
                "r.txt, then read it back to confirm.")
DEFAULT_VERIFY = {"expect_file": "r.txt", "expect_contains": "3"}


def ik_token() -> str:
    t = os.environ.get("IK_TOKEN", "").strip()
    if t:
        return t
    p = Path.home() / ".config/agent-service/model-token"
    if p.exists():
        return p.read_text().strip()
    sys.exit("set IK_TOKEN or place the Infomaniak token at " + str(p))


def token_for(mode: dict) -> str:
    """Resolve the upstream token for `mode`. IK_TOKEN routes through ik_token() (legacy file
    fallback); every other token_env must come from the environment — no file fallback, so a
    missing CSCS/etc token fails loud instead of silently reusing an unrelated credential."""
    if mode["token_env"] == "IK_TOKEN":   # noqa: S105 — an env var NAME, not a credential   # noqa: S105 — an env var NAME, not a credential
        return ik_token()
    t = os.environ.get(mode["token_env"], "").strip()
    if t:
        return t
    sys.exit(f"set {mode['token_env']} in the environment")


def snapshot_models(base: str, tok: str) -> list[str]:
    """GET {base}/models — the live catalog right now. Some upstreams (the CSCS research cluster in
    particular) churn on an hours timescale — a checkpoint can rotate out mid-session — so a result
    is only reproducible alongside the catalog snapshot that produced it."""
    # user-agent matches api/proxy.py's UPSTREAM_USER_AGENT: the gateway upstream's WAF rejects the
    # default Python-urllib UA. The other upstreams accept the default.
    req = urllib.request.Request(f"{base}/models",
                                  headers={"Authorization": f"Bearer {tok}", "x-agent-account": "user", "user-agent": "curl/8.5.0"})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=15))
    except Exception as e:  # noqa: BLE001
        sys.exit(f"could not enumerate {base}/models: {type(e).__name__}: {e}")
    return sorted(m.get("id", "") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id"))


def check_model_live(mode: dict, tok: str) -> list[str]:
    """Fail loud if `mode['model']` isn't in the live catalog right now, instead of silently running
    against whatever the upstream does with an unrecognized model id. Returns the snapshot so the
    caller can log it alongside the run."""
    ids = snapshot_models(mode["base"], tok)
    if mode["model"] not in ids:
        near = [i for i in ids if any(p in i.lower() for p in ("apertus", "mistral", "qwen"))][:10]
        sys.exit(f"{mode['model']} is NOT in the live catalog at {mode['base']} ({len(ids)} models) — "
                 f"it may have rotated out. Closest matches: {near or ids[:10]}")
    return ids


def check_tool_calls_live(mode: dict, tok: str) -> str:
    """Catalog membership is not the dependency: an id can stay in the catalog while tool calling stops
    working. A run that starts against such an endpoint scores it as a row of model failures, which is
    the most expensive way to find out. Refuses to start the run rather than mislabel one."""
    spec = importlib.util.spec_from_file_location("modelcheck", Path(__file__).resolve().parent / "modelcheck.py")
    mc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mc)
    rows = mc.probe(mode["base"].rstrip("/"), mode["model"], tok, 2)
    broken = [r for r in rows if r[3] and r[1] < r[2]]
    if broken:
        sys.exit(f"{mode['model']} is in the catalog but is NOT emitting tool calls "
                 f"({', '.join(f'{r[0]} {r[1]}/{r[2]}' for r in broken)}). Every trial would fail and be "
                 f"scored as the model missing the task. Run scripts/modelcheck.py; this is R1h and it "
                 f"clears on its own.")
    return " ".join(f"{r[0]} {r[1]}/{r[2]}" for r in rows if r[3])


# ---- service lifecycle (same pattern as passk_service.py) ---------------------------------------
_procs: list[tuple[subprocess.Popen, "object"]] = []


def _spawn(argv: list[str], env: dict, log: Path) -> subprocess.Popen:
    log_handle = open(log, "w")
    p = subprocess.Popen(argv, cwd=str(API), env=env, stdout=log_handle, stderr=subprocess.STDOUT,
                         start_new_session=True)
    _procs.append((p, log_handle))
    return p


def _kill(p: "subprocess.Popen | None", log_handle: "object" = None) -> None:
    if p is None:
        return
    try:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            p.wait(timeout=10)
        except Exception:  # noqa: BLE001
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        if log_handle is not None:
            log_handle.close()


@atexit.register
def _cleanup() -> None:
    for p, log_handle in list(_procs):
        _kill(p, log_handle)


def _on_signal(signum, _frame) -> None:
    # atexit does NOT run on SIGTERM/SIGINT — without this, `timeout`/Ctrl-C would leak the
    # spawned proxy+app onto their ports. Re-raise as a clean exit so _cleanup() fires.
    sys.exit(128 + signum)


for _sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(_sig, _on_signal)


def _wait_health(port: int, tries: int = 40) -> bool:
    for _ in range(tries):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2)
            return True
        except Exception:  # noqa: BLE001
            time.sleep(1)
    return False


PROXY_LOG = "/tmp/dogfood_proxy.log"

# Proxy-side knobs this harness pins, named once so a drift check can assert them against
# the deployed gateway config instead of asserting only what the app process sets. They live in a separate
# process from the app's env, which is exactly why they escaped the parity check for so long.
PROXY_ENV = {
    # A measurement run without per-call timing cannot be traced afterwards; see _plog in api/proxy.py.
    "PROXY_LOG_REQUESTS": "1",
    # The two halves of the upstream-silence ceiling. MODEL_UPSTREAM_TIMEOUT bounds silence BETWEEN
    # frames and is left to its code default, the same as prod. These bound silence BEFORE the first
    # frame, and prod states them in the gateway config, so the harness has to state them too or a
    # stall costs 120s here and ~30s in prod — a different failure rate measured on the same upstream.
    "MODEL_FIRST_TOKEN_TIMEOUT": os.environ.get("MODEL_FIRST_TOKEN_TIMEOUT", "30"),
    "MODEL_FIRST_TOKEN_ATTEMPTS": os.environ.get("MODEL_FIRST_TOKEN_ATTEMPTS", "2"),
}
# PROXY_DESTREAM is OFF here, which is what the deployed gateway ships. It exists for an upstream whose
# tool-call parser only runs on the non-streaming codepath. Against CSCS/Apertus-1.5 the streaming path
# returns real `tool_calls` deltas and no call-shaped prose in `content` (first frame at ~0.55s), so
# destreaming buys nothing and costs the thing that matters: every streaming request becomes a blocking
# upstream call replayed as one synthetic burst, no frame arrives mid-call, and the harness measures a
# frame regime prod does not serve. Set PROXY_DESTREAM=1 to put it back for an upstream that needs it; the key
# is OMITTED rather than set to "0" when off, so prodcheck sees the same code default prod runs.
if os.environ.get("PROXY_DESTREAM", "") not in ("", "0", "false"):
    PROXY_ENV["PROXY_DESTREAM"] = "1"


def start_proxy(tok: str, base: str = INFOMANIAK_BASE) -> None:
    # PROXY_LOG_REQUESTS is ON for every harness run, and not left to whoever remembers to export it.
    # It is off by default in prod for volume, but a measurement run without per-call timing is a run
    # whose result cannot be traced afterwards: a trial that spends 306s on 4 model calls cannot be split
    # into upstream stalls and slow serves.
    # The lines are content-free by contract (_request_meta) — ids, counts and params, never messages.
    env = {**os.environ, "MODEL_UPSTREAM_TOKEN": tok, "MODEL_UPSTREAM_BASE": base,
           "PROXY_ADMIN_KEY": ADMIN, **PROXY_ENV}
    # Per-run path: a fixed /tmp/dogfood_proxy.log lets a later run clobber an earlier one's usage lines,
    # and the survivor gets read as the earlier run's. Token accounting must not be misattributed.
    global PROXY_LOG
    PROXY_LOG = f"/tmp/dogfood_proxy-{os.getpid()}.log"
    _spawn([PY, "-m", "uvicorn", "proxy:app", "--host", "127.0.0.1", "--port", str(PPORT)],
           env, Path(PROXY_LOG))
    if not _wait_health(PPORT):
        sys.exit(f"proxy did not come up — see {PROXY_LOG}")


def start_app(model: str, mode_env: dict) -> None:
    env = {**os.environ,
           "AGENT_MODEL_PROXY_URL": f"http://127.0.0.1:{PPORT}", "PROXY_ADMIN_KEY": ADMIN,
           "AGENT_MODEL": model, "AGENT_MODEL_PROVIDER": "huggingface",
           "AGENT_MAX_STEPS": str(CAP), "AGENT_MAX_TOKENS": str(TOKEN_CAP), "AGENT_SANDBOX": "off", "AGENT_SANDBOX_BACKEND": "bwrap",
           "AGENT_AUTH_DISABLED": "1", "AGENT_MODERATION_DISABLED": "1",
           "HERMES_BIN": HERMES, "AGENT_DB_PATH": "/tmp/dogfood_app.db",
           "AGENT_WALL_CLOCK_SECS": str(WALL), **mode_env}
    _spawn([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(APORT)],
           env, Path("/tmp/dogfood_app.log"))
    if not _wait_health(APORT):
        sys.exit("app did not come up — see /tmp/dogfood_app.log")


# ---- one task through the service ---------------------------------------------------------------
def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:{APORT}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def _get(path: str) -> dict:
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{APORT}{path}", timeout=30))


def run_task(task: str, verify: "dict | None") -> dict:
    body = {"prompt": task}
    if verify:
        body["verify"] = verify
    rid = _post("/run", body).get("id", "")
    if not rid:
        sys.exit("POST /run did not return an id — see /tmp/dogfood_app.log")
    print(f"  submitted run {rid} — polling (up to {WALL}s)…", flush=True)
    out: dict = {}
    # State enum serializes UPPERCASE (`State` in api/app.py) — compare case-insensitively so we break
    # the instant the task is terminal instead of polling the whole window.
    for _ in range(int(WALL / 3) + 20):
        out = _get(f"/run/{rid}")
        if str(out.get("state", "")).upper() in ("COMPLETED", "FAILED", "CANCELED"):
            break
        print("  ·", end="", flush=True)
        time.sleep(3)
    print()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Drive the real agent service end-to-end (one task).")
    ap.add_argument("mode", choices=list(MODES),
                     help="apertus15 (shipped default, via the real LiteLLM gateway), apertus15-8b "
                          "(control), mistral (prior default, baseline), or qwen (fallback)")
    ap.add_argument("task", nargs="?", default=None, help="task prompt (default: the bounded count task)")
    ap.add_argument("--expect-file", default=None, help="verify: file the task must create")
    ap.add_argument("--expect-contains", default=None, help="verify: substring the file must contain")
    ap.add_argument("--check-cmd", default=None, help="verify: shell command to run (mutually exclusive "
                     "with --expect-file, unvalidated client-side — the server's own 400 does that job)")
    args = ap.parse_args()

    mode = MODES[args.mode]
    if not mode["base"]:
        base_env = mode["token_env"].rsplit("_TOKEN", 1)[0] + "_BASE"
        sys.exit(f"{args.mode} has no upstream base configured — set {base_env}")
    task = args.task or DEFAULT_TASK
    if args.expect_file:
        verify: dict | None = {"expect_file": args.expect_file}
        if args.expect_contains is not None:
            verify["expect_contains"] = args.expect_contains
    elif args.check_cmd:
        verify = {"check_cmd": args.check_cmd}
    elif args.task is None:
        verify = DEFAULT_VERIFY          # the known-good default task ships with its verify spec
    else:
        verify = None                    # custom task, no verify given

    # best-of-N only engages with a verify spec — warn so a run isn't silently single-attempt.
    if mode["env"].get("AGENT_BEST_OF") and verify is None:
        print("  note: no verify spec → single-attempt, best-of-N disabled.\n")

    print(f"== dogfood: {args.mode} ==  {mode['blurb']}")
    print(f"   model={mode['model']}  upstream={mode['upstream_name']}  verify={verify or 'none'}")
    print(f"   task: {task}\n")

    tok = token_for(mode)
    ids = check_model_live(mode, tok)
    print(f"   catalog: {len(ids)} models live at {mode['base']} (target confirmed present)")
    print(f"   tool calls: {check_tool_calls_live(mode, tok)}\n")

    start_proxy(tok, mode["base"])
    start_app(mode["model"], mode["env"])
    out = run_task(task, verify)

    state = str(out.get("state", "")).upper()
    verified = out.get("verified")
    mark = "✅ VERIFIED" if verified else ("✅ done (unverified)" if state == "COMPLETED" else f"❌ {state or 'no result'}")
    print(f"  result : {mark}")
    print(f"  state  : {state}   calls={out.get('model_calls', 0)}  tokens={out.get('tokens', 0)}")
    if out.get("summary"):
        print(f"  summary: {out['summary']}")
    if out.get("error"):
        print(f"  error  : {out['error']}")
    if out.get("result"):
        tail = out["result"] if not out.get("result_truncated") else "…" + out["result"]
        print(f"  output : {tail[:600]}")
    # exit non-zero when a verify spec was given but not satisfied — makes the harness CI-usable.
    sys.exit(0 if (verified or (verify is None and state == "COMPLETED")) else 1)


if __name__ == "__main__":
    main()
