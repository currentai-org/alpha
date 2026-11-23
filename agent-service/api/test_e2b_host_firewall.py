"""The E2B host's sandbox firewall must not depend on the WireGuard tunnel or its key."""

import re
from pathlib import Path

E2B = Path(__file__).resolve().parent.parent / "deploy" / "aws" / "e2b"


def _read(name: str) -> str:
    return (E2B / name).read_text()


def _code(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _main_steps() -> list[tuple[str, str]]:
    """(step name, template file) in the order the SSM document runs them."""
    block = _read("wireguard.tf").split("mainSteps", 1)[1]
    return re.findall(r'name\s*=\s*"(\w+)".*?templatefile\("\$\{path\.module\}/([\w.-]+)"', block, re.S)


def test_the_e2b_host_firewall_is_applied_before_and_without_the_wireguard_key():
    steps = _main_steps()
    assert [n for n, _ in steps] == ["firewall", "wireguard"], steps
    assert dict(steps)["firewall"] == "firewall-host.sh.tftpl"

    firewall = _code(_read("firewall-host.sh.tftpl"))
    for needle in ("wg-quick", "wg0.conf", "key_param", "ssm get-parameter", "PrivateKey", "systemctl enable --now"):
        assert needle not in firewall, f"firewall step reads or starts the tunnel: {needle}"
    assert not re.search(r"After=.*wg-quick", firewall)
    # The metadata and private-range rules are in the step that cannot be skipped.
    for rule in ("169.254.169.254", "POTLUCK_IMDS", "POTLUCK_GUEST", "10.0.0.0/8", "192.168.0.0/16", "E2B_WG"):
        assert rule in firewall, rule


def test_the_e2b_host_tunnel_step_carries_no_firewall_rules():
    tunnel = _code(_read("wg-host.sh.tftpl"))
    assert "iptables" not in tunnel and "potluck-e2b-firewall" not in tunnel
