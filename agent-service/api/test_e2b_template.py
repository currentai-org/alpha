"""The E2B guest image runs the same Hermes as the service image (CUR-4482)."""

import re
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"


def _arg(dockerfile: Path, name: str) -> str:
    m = re.search(rf'^ARG {name}="?([^"\s]+)"?', dockerfile.read_text(), re.M)
    assert m, f"{dockerfile} has no ARG {name}"
    return m.group(1)


def test_the_sandbox_image_pins_the_hermes_the_service_image_pins():
    for name in ("HERMES_GIT_URL", "HERMES_SHA"):
        assert _arg(DEPLOY / "e2b-template" / "Dockerfile", name) == _arg(DEPLOY / "Dockerfile", name)


def test_the_sandbox_image_applies_the_same_patches_and_carries_no_agent_service_code():
    text = (DEPLOY / "e2b-template" / "Dockerfile").read_text()
    assert "COPY hermes/ /tmp/hermes-patches/" in text
    assert "COPY api" not in text and "requirements.txt" not in text


# What the agent prompt (app.py COMPUTATION_NOTE) tells the model to write files with, by pip name.
_FILE_LIBRARIES = ("numpy", "pandas", "matplotlib", "openpyxl", "python-docx", "reportlab")


def _pins(text: str) -> dict[str, str]:
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r"(?<![\w-])([A-Za-z][\w-]*)==([\w.]+)", text)}


def test_the_sandbox_image_installs_every_file_library_at_the_service_pin():
    """A task on E2B can write Excel, Word and PDF as a task on bwrap can (CUR-4106): every library the agent
    prompt names is installed in the guest image, at requirements.txt's version."""
    image = _pins((DEPLOY / "e2b-template" / "guest-libraries.txt").read_text())
    service = _pins((DEPLOY.parent / "requirements.txt").read_text())
    for lib in _FILE_LIBRARIES:
        assert lib in service, f"requirements.txt has no pin for {lib}"
        assert image.get(lib) == service[lib], f"the E2B image installs {lib}=={image.get(lib)}, the service pins {service[lib]}"


def test_a_client_that_names_no_template_gets_the_one_the_build_script_builds():
    """E2BConfig's default is the alias deploy/e2b-template builds, never Embed's own "base", which has no Hermes
    and whose parent layers a fresh host may not hold; the contract suite and the app both fall back to it."""
    from sandbox_e2b import E2BConfig

    m = re.search(r"E2B_TEMPLATE_ALIAS \|\| '([\w-]+)'", (DEPLOY / "e2b-template" / "build.mjs").read_text())
    assert m, "build.mjs no longer names its default alias"
    assert E2BConfig(api_url="http://e2b.invalid", api_key="k").template == m.group(1)
