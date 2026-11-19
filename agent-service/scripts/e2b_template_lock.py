"""The E2B template lock: which build inputs the `hermes` sandbox template was last rebuilt from.

A PR that bumps a library in requirements.txt and guest-libraries.txt together passes every PR gate,
test_e2b_template.py included, because the two files agree with each other. Nothing else compares them
with the template actually running on the E2B hosts (agent-service-deploy.yml's `template` job only warns
while its variables are unset), so the service would run one set of libraries and the guest another.

deploy/e2b-template.lock records a digest of what the template image is built from. A PR that changes those
inputs without moving the lock fails `scripts/tests/test_e2b_template_lock.py` in agent-service CI. The lock
moves after the template has been rebuilt from the new inputs: build-on-host.sh on each host, then

    python scripts/e2b_template_lock.py --write     # in agent-service/

The lock sits outside deploy/e2b-template/, so editing it neither enters the build context nor sets off the
deploy's rebuild by itself. A dependency change reaches this lock only through the pins the guest image
shares with the service: test_e2b_template.py fails a requirements.txt bump of a file library that leaves
guest-libraries.txt behind, and moving guest-libraries.txt moves this digest.

    python scripts/e2b_template_lock.py             # exit 1 and say why when the lock is stale
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"
LOCK = "e2b-template.lock"

# What the image is built from, relative to deploy/. build-on-host.sh ships deploy/e2b-template/ and
# deploy/hermes/ as the build context, but only these change the image: the Dockerfile, the files it COPYs
# (guest-libraries.txt, and hermes/, of which it applies only the *.patch files and then deletes the rest),
# and build.mjs's template settings (alias, CPU, memory). smoke.mjs and the host scripts drive the build and
# change nothing in it. `uncovered_copies` fails a COPY source added to the Dockerfile but not listed here.
INPUT_FILES = ("e2b-template/Dockerfile", "e2b-template/guest-libraries.txt", "e2b-template/build.mjs")
INPUT_GLOBS = ("hermes/*.patch",)
# A full-line `#` comment or a blank line changes nothing these files build, so it doesn't move the digest.
HASH_COMMENTS = ("e2b-template/Dockerfile", "e2b-template/guest-libraries.txt")

_LOCK_LINE = re.compile(r"^inputs\s*=\s*([0-9a-f]{64})\s*$", re.M)
_HEADER = """\
# Digest of the E2B template's build inputs, as last rebuilt on the hosts (scripts/e2b_template_lock.py).
# Move it only after the `hermes` template has been rebuilt from these inputs: build-on-host.sh on the develop
# host, and on production's before the change is promoted. Then `python scripts/e2b_template_lock.py --write`.
"""


def input_files(deploy: Path = DEPLOY) -> list[str]:
    files = set(INPUT_FILES)
    for pattern in INPUT_GLOBS:
        files.update(p.relative_to(deploy).as_posix() for p in deploy.glob(pattern) if p.is_file())
    return sorted(files)


# BuildKit parser directives (`# syntax=...`, `# check=...`, `# escape=...`) are comments only in form:
# they change how the image is built, so they are hashed. Docker reads them only before the first
# instruction, blank line or ordinary comment, which is the rule _leading_directives follows.
_DIRECTIVE = re.compile(r"^#\s*[A-Za-z][A-Za-z0-9_-]*\s*=")


def _leading_directives(text: str) -> list[str]:
    out = []
    for ln in text.splitlines():
        if not _DIRECTIVE.match(ln):
            break
        out.append(ln.strip())
    return out


def _content(deploy: Path, rel: str) -> bytes:
    data = (deploy / rel).read_bytes()
    if rel not in HASH_COMMENTS:
        return data
    text = data.decode()
    directives = _leading_directives(text) if rel.endswith("Dockerfile") else []
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    return "\n".join(directives + lines).encode()


def inputs_digest(deploy: Path = DEPLOY) -> str:
    h = hashlib.sha256()
    for rel in input_files(deploy):
        h.update(f"{rel}\0{hashlib.sha256(_content(deploy, rel)).hexdigest()}\n".encode())
    return h.hexdigest()


def locked_digest(deploy: Path = DEPLOY) -> str | None:
    path = deploy / LOCK
    if not path.exists():
        return None
    m = _LOCK_LINE.search(path.read_text())
    return m.group(1) if m else None


def copy_sources(dockerfile: str) -> list[str]:
    """The build-context paths a Dockerfile's COPY lines read, relative to deploy/e2b-template/."""
    out = []
    for m in re.finditer(r"^COPY\s+(?!--from)(.+)$", dockerfile, re.M):
        parts = [p for p in m.group(1).split() if not p.startswith("--")]
        out.extend(parts[:-1])
    return out


def unreadable_copy_forms(dockerfile: str) -> list[str]:
    """Instructions that bring build-context files in but copy_sources cannot read: ADD, the JSON form
    of COPY, and a COPY whose sources continue on the next line. The lock fails closed on them rather
    than let a new build input go unhashed."""

    def unreadable(s: str) -> bool:
        if re.match(r"^ADD\s", s, re.I):
            return True
        if not re.match(r"^COPY\s", s, re.I) or "--from" in s:
            return False
        json_form = re.match(r"^COPY\s+(--\S+\s+)*\[", s, re.I) is not None
        return json_form or s.endswith("\\")

    return [ln.strip() for ln in dockerfile.splitlines() if unreadable(ln.strip())]


def uncovered_copies(deploy: Path = DEPLOY) -> list[str]:
    """COPY sources whose files the digest does not cover. build-on-host.sh puts deploy/hermes/ at hermes/."""
    covered = input_files(deploy)
    missing = []
    for src in copy_sources((deploy / "e2b-template" / "Dockerfile").read_text()):
        rel = src if src.startswith("hermes") else f"e2b-template/{src}"
        rel = rel.rstrip("/")
        if not any(f == rel or f.startswith(f"{rel}/") for f in covered):
            missing.append(src)
    return missing


def drift(deploy: Path = DEPLOY) -> str | None:
    """Why the lock does not match the template inputs, or None when it does."""
    unreadable = unreadable_copy_forms((deploy / "e2b-template" / "Dockerfile").read_text())
    if unreadable:
        return (
            f"The E2B template Dockerfile uses {', '.join(repr(u) for u in unreadable)}, which the template lock "
            "cannot read, so a build input could go unhashed. Use single-line shell-form COPY, or teach "
            "copy_sources in scripts/e2b_template_lock.py to read it."
        )
    missing = uncovered_copies(deploy)
    if missing:
        return (
            f"The E2B template Dockerfile COPYs {', '.join(missing)}, which the template lock's digest does not cover. "
            "Add it to INPUT_FILES or INPUT_GLOBS in scripts/e2b_template_lock.py."
        )
    now, locked = inputs_digest(deploy), locked_digest(deploy)
    if now == locked:
        return None
    was = f"deploy/{LOCK} says {locked}" if locked else f"deploy/{LOCK} is missing or names no digest"
    return (
        f"The E2B template's build inputs changed (now {now}; {was}), but the template was not recorded as "
        "rebuilt. Nothing rebuilds it on merge yet: agent-service-deploy.yml's template job only warns while "
        "the CUR-4573 variables are unset, which is how #4555 shipped drift and #4556 reverted it. Rebuild "
        "the template with deploy/e2b-template/build-on-host.sh on the develop host (and production's before "
        "promoting), then run `python scripts/e2b_template_lock.py --write` in agent-service/ and commit the "
        "lock, citing the build's log in the PR. The digest covers: " + ", ".join(input_files(deploy))
    )


def write_lock(deploy: Path = DEPLOY) -> str:
    digest = inputs_digest(deploy)
    (deploy / LOCK).write_text(f"{_HEADER}inputs = {digest}\n")
    return digest


def main(argv: list[str], deploy: Path = DEPLOY) -> int:
    if argv[1:] == ["--write"]:
        print(f"deploy/{LOCK}: inputs = {write_lock(deploy)}")
        return 0
    if argv[1:]:
        print("usage: e2b_template_lock.py [--write]", file=sys.stderr)
        return 2
    why = drift(deploy)
    if why:
        print(why, file=sys.stderr)
        return 1
    print(f"deploy/{LOCK} matches the template inputs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
