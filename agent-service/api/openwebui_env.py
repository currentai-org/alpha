"""Start the self-host model gateway from the stack's model env, Open WebUI's names included.

The self-host stack (selfhost/compose.yaml, agent profile) points the gateway at the endpoint chat uses:
OPENAI_BASE_URL with OPENAI_API_KEY, or, for an operator moving from Open WebUI, OPENAI_API_BASE_URLS with
OPENAI_API_KEYS. resolve_openai_env decides which, the same way the web app's resolveOpenAiEnv does
(web/src/lib/chat/server/env/openWebUiAliases.ts); both are tested against
testdata/openwebui-env-cases.json. Names only: nothing here comes from Open WebUI's code.

Run as a script, it sets PROVIDER_STACK_BASE / PROVIDER_STACK_TOKEN from the result and starts
gateway_serve. The hosted gateway never runs this file.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Mapping


def _split_list(raw: str) -> list[str]:
    # "a;b;" is a common spelling of a two-item list, so one trailing empty item is dropped.
    if not raw.strip():
        return []
    parts = [p.strip() for p in raw.split(";")]
    if len(parts) > 1 and parts[-1] == "":
        parts.pop()
    return parts


def resolve_openai_env(env: Mapping[str, str]) -> dict:
    """Decide which name set supplies the model endpoint. The keys of the result match the web app's
    OpenAiEnvResolution (source, baseUrl, apiKey, ignoredEndpoints, keysGiven, openWebUiShadowed), and a field
    the TS leaves undefined is left out here. Keys pair with URLs as Open WebUI pairs them: OPENAI_API_KEYS
    falls back to OPENAI_API_KEY, a missing key is empty (a keyless endpoint) and an extra key is dropped.
    Raises ValueError only when the first URL is empty."""
    own = (env.get("OPENAI_BASE_URL") or "").strip()
    urls_raw = env.get("OPENAI_API_BASE_URLS") or ""
    keys_raw = env.get("OPENAI_API_KEYS") or ""
    owui_set = bool(urls_raw.strip())

    if own:
        return {"source": "alpha", "ignoredEndpoints": 0, "openWebUiShadowed": owui_set}
    if not owui_set:
        return {"source": "none", "ignoredEndpoints": 0, "openWebUiShadowed": False}

    urls = _split_list(urls_raw)
    given = _split_list(keys_raw if keys_raw.strip() else (env.get("OPENAI_API_KEY") or ""))
    keys = [given[i] if i < len(given) else "" for i in range(len(urls))]
    if not urls[0]:
        raise ValueError("OPENAI_API_BASE_URLS starts with an empty URL; the first entry must be a base URL.")
    out = {
        "source": "open-webui",
        "baseUrl": urls[0],
        "apiKey": keys[0],
        "ignoredEndpoints": len(urls) - 1,
        "openWebUiShadowed": False,
    }
    if len(given) != len(urls):
        out["keysGiven"] = len(given)
    return out


def gateway_env(env: Mapping[str, str]) -> tuple[dict[str, str], list[str]]:
    """The PROVIDER_STACK_* values for the gateway, and the lines to log about how they were chosen.
    Raises ValueError, with the message to print, when no endpoint is set."""
    r = resolve_openai_env(env)
    notes: list[str] = []
    if r["source"] == "none":
        raise ValueError("the agent profile needs OPENAI_BASE_URL, or Open WebUI's OPENAI_API_BASE_URLS, in .env")
    if r["source"] == "alpha":
        base, key = (env.get("OPENAI_BASE_URL") or "").strip(), env.get("OPENAI_API_KEY") or ""
        notes.append("gateway: model endpoint from OPENAI_BASE_URL")
        if r["openWebUiShadowed"]:
            notes.append("gateway: OPENAI_API_BASE_URLS is set too and is ignored, since OPENAI_BASE_URL wins")
    else:
        base, key = r["baseUrl"], r["apiKey"]
        notes.append(f"gateway: model endpoint from OPENAI_API_BASE_URLS: {base}")
        if r["ignoredEndpoints"]:
            notes.append(f"gateway: {r['ignoredEndpoints']} more endpoint(s) in OPENAI_API_BASE_URLS ignored; Alpha serves one")
        if "keysGiven" in r:
            notes.append(f"gateway: OPENAI_API_KEYS held {r['keysGiven']} key(s) for the URLs; missing keys are keyless, extras dropped")
    # The gateway skips a provider with an empty token, so a keyless endpoint sends the placeholder "none".
    return {"PROVIDER_STACK_BASE": base, "PROVIDER_STACK_TOKEN": key or "none"}, notes


def main() -> int:
    try:
        values, notes = gateway_env(os.environ)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    for line in notes:
        print(line, flush=True)
    os.environ.update(values)
    # proxy reads PROVIDER_STACK_* when it is imported, so gateway_serve is imported only now.
    import gateway_serve

    asyncio.run(gateway_serve.main())
    return 0


if __name__ == "__main__":
    sys.exit(main())
