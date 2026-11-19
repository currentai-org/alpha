"""The E2B template lock fails a PR that changes what the sandbox image is built from without recording a
rebuild, and stays out of the way of everything else (scripts/e2b_template_lock.py).

A two-file pin bump is replayed on a copy of deploy/: it keeps test_e2b_template.py's pin check green, so it
passes every other PR gate, and must turn the lock check red.
"""

import re
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from scripts.e2b_template_lock import (
    DEPLOY,
    LOCK,
    copy_sources,
    drift,
    inputs_digest,
    locked_digest,
    main,
    write_lock,
)

SERVICE_REQUIREMENTS = DEPLOY.parent / "requirements.txt"


def _pins(text: str) -> dict[str, str]:
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r"(?<![\w-])([A-Za-z][\w-]*)==([\w.]+)", text)}


@pytest.fixture
def deploy(tmp_path: Path) -> Path:
    """A copy of deploy/ with requirements.txt beside it, as in agent-service/, its lock matching its inputs."""
    root = tmp_path / "agent-service"
    shutil.copytree(DEPLOY, root / "deploy")
    shutil.copy(SERVICE_REQUIREMENTS, root / "requirements.txt")
    write_lock(root / "deploy")
    return root / "deploy"


def _edit(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    assert old in text, f"{path.name} no longer holds {old!r}; update this fixture"
    path.write_text(text.replace(old, new))


def _bump(path: Path, lib: str, version: str) -> None:
    text = path.read_text()
    new, n = re.subn(rf"^{re.escape(lib)}==[\w.]+$", f"{lib}=={version}", text, flags=re.M)
    assert n == 1, f"{path.name} has no single pin for {lib}"
    path.write_text(new)


def test_the_committed_lock_matches_the_template_inputs_on_this_tree():
    """Red here means this tree changed the template inputs without moving deploy/e2b-template.lock: rebuild
    the template, then `python scripts/e2b_template_lock.py --write`."""
    assert drift() is None, drift()


def test_a_two_file_pin_bump_fails_the_lock_though_the_pin_agreement_check_passes(deploy: Path):
    guest = deploy / "e2b-template" / "guest-libraries.txt"
    service = deploy.parent / "requirements.txt"
    for path in (service, guest):  # the starting state, locked as built
        _bump(path, "pandas", "3.0.6")
        _bump(path, "reportlab", "5.0.1")
    write_lock(deploy)
    for path in (service, guest):  # the bump: both files, the same two pins
        _bump(path, "pandas", "3.1.0")
        _bump(path, "reportlab", "5.1.0")

    image, svc = _pins(guest.read_text()), _pins(service.read_text())
    assert (image["pandas"], image["reportlab"]) == (svc["pandas"], svc["reportlab"]) == ("3.1.0", "5.1.0")

    why = drift(deploy)
    assert why is not None
    assert "build-on-host.sh" in why and "--write" in why


def test_the_same_bump_passes_once_the_lock_is_moved_with_it(deploy: Path):
    _bump(deploy / "e2b-template" / "guest-libraries.txt", "pandas", "999.0")
    assert drift(deploy) is not None
    write_lock(deploy)
    assert drift(deploy) is None


@pytest.mark.parametrize(
    "change",
    [
        "a requirements.txt bump of a library the guest image does not carry",
        "a comment-only edit to guest-libraries.txt and the Dockerfile",
        "an edit to smoke.mjs, which drives the build and is not built into the image",
        "an edit to hermes/UPSTREAM.md, which the Dockerfile copies in and deletes unapplied",
        "a change to the service's own code",
    ],
)
def test_a_change_the_template_is_not_built_from_leaves_the_lock_green(deploy: Path, change: str):
    agent = deploy.parent
    if change.startswith("a requirements.txt"):
        _bump(agent / "requirements.txt", "fastapi", "0.999.0")
    elif change.startswith("a comment-only"):
        _edit(deploy / "e2b-template" / "guest-libraries.txt", "# At the service's pins", "# At the service's pins.")
        _edit(deploy / "e2b-template" / "Dockerfile", "FROM python", "# reworded\n\nFROM python")
    elif "smoke.mjs" in change:
        (deploy / "e2b-template" / "smoke.mjs").write_text("// changed\n")
    elif "UPSTREAM.md" in change:
        (deploy / "hermes" / "UPSTREAM.md").write_text("changed\n")
    else:
        (agent / "api").mkdir(exist_ok=True)
        (agent / "api" / "app.py").write_text("changed = True\n")
    assert drift(deploy) is None


@pytest.mark.parametrize(
    "change",
    ["a new Hermes patch", "a Dockerfile step", "build.mjs's template memory", "a guest library pin"],
)
def test_every_kind_of_template_input_moves_the_digest(deploy: Path, change: str):
    before = inputs_digest(deploy)
    if change == "a new Hermes patch":
        (deploy / "hermes" / "0003-new.patch").write_text("diff --git a/x b/x\n")
    elif change == "a Dockerfile step":
        _edit(deploy / "e2b-template" / "Dockerfile", "FROM python:3.14-slim", "FROM python:3.14-slim\nRUN true")
    elif change == "build.mjs's template memory":
        _edit(deploy / "e2b-template" / "build.mjs", "memoryMB: 1024", "memoryMB: 2048")
    else:
        _bump(deploy / "e2b-template" / "guest-libraries.txt", "scipy", "9.9.9")
    assert inputs_digest(deploy) != before
    assert drift(deploy) is not None


def test_a_copy_source_the_digest_does_not_cover_fails(deploy: Path):
    df = deploy / "e2b-template" / "Dockerfile"
    (deploy / "e2b-template" / "extra.txt").write_text("x\n")
    df.write_text(df.read_text() + "COPY extra.txt /tmp/extra.txt\n")
    write_lock(deploy)
    why = drift(deploy)
    assert why is not None and "extra.txt" in why


def test_copy_sources_reads_every_source_and_skips_flags_and_stage_copies():
    text = "COPY --chown=1:1 a.txt b/ /dst/\nCOPY --from=build /x /y\nRUN echo COPY z\n"
    assert copy_sources(text) == ["a.txt", "b/"]


def test_a_missing_lock_fails(deploy: Path):
    (deploy / LOCK).unlink()
    assert locked_digest(deploy) is None
    assert drift(deploy) is not None


def test_the_cli_exits_nonzero_on_drift_zero_on_a_match_and_write_clears_it(deploy: Path):
    assert main(["x"], deploy) == 0
    _bump(deploy / "e2b-template" / "guest-libraries.txt", "pandas", "999.0")
    assert main(["x"], deploy) == 1
    assert main(["x", "--bogus"], deploy) == 2
    assert main(["x", "--write"], deploy) == 0
    assert main(["x"], deploy) == 0


@pytest.mark.parametrize(
    "line",
    [
        "ADD extra.txt /tmp/extra.txt",
        'COPY ["extra.txt", "/tmp/extra.txt"]',
        "COPY --chown=1:1 extra.txt \\\n    /tmp/extra.txt",
    ],
)
def test_a_copy_form_the_lock_cannot_read_fails_closed(deploy: Path, line: str):
    df = deploy / "e2b-template" / "Dockerfile"
    (deploy / "e2b-template" / "extra.txt").write_text("x\n")
    df.write_text(df.read_text() + line + "\n")
    write_lock(deploy)
    why = drift(deploy)
    assert why is not None and "cannot read" in why


def test_a_buildkit_parser_directive_moves_the_digest_but_an_ordinary_comment_does_not(deploy: Path):
    df = deploy / "e2b-template" / "Dockerfile"
    before = inputs_digest(deploy)
    original = df.read_text()
    df.write_text("# a note about this file\n" + original)
    assert inputs_digest(deploy) == before
    df.write_text("# syntax=docker/dockerfile:1.7\n" + original)
    assert inputs_digest(deploy) != before
