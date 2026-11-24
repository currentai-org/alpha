#!/usr/bin/env python3
"""Render one role's container env for the AWS hosts.

    doppler secrets download --no-file --format json ... | \\
        render_env.py --role agent --deploy deploy.json > env

Three layers, later ones winning:

1. The role's tracked [env] table (deploy/env/agent.toml or deploy/env/gateway.toml), so a model or limit change
   lands in one reviewed file.
2. The Doppler secrets this role takes, named in <role>.keys plus <role>.<stack>.keys when that file exists (the
   settings only one stack runs with, such as production's staged permission policy). A name with a trailing `?`
   is optional; any other missing name stops the render. Nothing else from the Doppler config reaches the role,
   so the agent never holds a model token even though the gateway's tokens sit in the same config.
3. Addresses only this platform knows (the gateway's private port, the E2B host, the public URLs), from
   `terraform output -json deploy`.

Prints KEY=VALUE lines for `docker run --env-file`, which takes each value raw to the end of the line, so a value
with a newline is refused rather than cut. Values are never printed anywhere else; errors name keys only.
"""
import argparse
import json
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_DIR = HERE.parents[1] / "env"
TOML = {"agent": ENV_DIR / "agent.toml", "gateway": ENV_DIR / "gateway.toml"}


def platform_env(role: str, deploy: dict) -> dict[str, str]:
    if role == "agent":
        return {
            "AGENT_MODEL_PROXY_URL": deploy["gateway_private"],
            "AGENT_GATEWAY_PUBLIC_URL": deploy["gateway_url"],
            "AGENT_SANDBOX_BACKEND": "e2b",
            "E2B_API_URL": deploy["e2b_api_url"],
            "E2B_SANDBOX_URL": deploy["e2b_sandbox_url"],
            # The watchdog is on by default only on Fly (api/app.py). Here systemd's Restart=always
            # (host-setup.sh.tftpl) restarts the container when the watchdog exits it. The ALB cannot route
            # around a hung server: with one target it sends traffic to an unhealthy one anyway.
            "AGENT_WATCHDOG_SECS": "20",
        }
    # The private port must answer over IPv4 here; Fly's 6PN is IPv6-only (api/gateway_serve.py).
    return {"GATEWAY_PRIVATE_HOST": "0.0.0.0"}


def read_keys(path: Path) -> tuple[list[str], set[str]]:
    names, optional = [], set()
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.endswith("?"):
            line = line[:-1]
            optional.add(line)
        names.append(line)
    return names, optional


def stack_keys(role: str, stack: str) -> tuple[list[str], set[str]]:
    """<role>.keys, then <role>.<stack>.keys when that stack has one."""
    names, optional = read_keys(HERE / f"{role}.keys")
    extra = HERE / f"{role}.{stack}.keys"
    if extra.exists():
        more, more_optional = read_keys(extra)
        names += [n for n in more if n not in names]
        optional = (optional - set(more)) | more_optional
    return names, optional


def render(role: str, toml_env: dict, secrets: dict, keys: list[str], optional: set[str], deploy: dict) -> dict[str, str]:
    missing = [k for k in keys if k not in secrets and k not in optional]
    if missing:
        raise SystemExit(f"Doppler config lacks {', '.join(missing)} for the {role} role ({role}.keys)")
    env = {k: str(v) for k, v in toml_env.items()}
    env.update({k: str(secrets[k]) for k in keys if k in secrets})
    env.update(platform_env(role, deploy))
    placeholders = sorted(k for k, v in env.items() if v.startswith("REPLACE"))
    if placeholders:
        raise SystemExit(f"{', '.join(placeholders)} still hold the toml's REPLACE placeholder: add them to {role}.keys and Doppler")
    # Production gates a first-time caller's writes and code (app.py, ACP_PERMISSION_POLICY); the service's own
    # default is allow, so an env that lost the setting would hand every stranger a writable sandbox.
    if role == "agent" and deploy.get("stack") == "production" and env.get("ACP_PERMISSION_POLICY", "allow") == "allow":
        raise SystemExit("ACP_PERMISSION_POLICY is allow or unset for the production agent; production runs staged")
    multiline = sorted(k for k, v in env.items() if "\n" in v or "\r" in v)
    if multiline:
        raise SystemExit(f"{', '.join(multiline)} span lines, which docker's --env-file cannot carry")
    return env


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--role", required=True, choices=sorted(TOML))
    p.add_argument("--deploy", required=True, help="the `deploy` object of `terraform output -json`")
    a = p.parse_args()
    deploy = json.loads(Path(a.deploy).read_text())
    toml_env = tomllib.loads(TOML[a.role].read_text()).get("env", {})
    keys, optional = stack_keys(a.role, deploy.get("stack", "develop"))
    env = render(a.role, toml_env, json.load(sys.stdin), keys, optional, deploy)
    sys.stdout.write("".join(f"{k}={v}\n" for k, v in sorted(env.items())))


if __name__ == "__main__":
    main()
