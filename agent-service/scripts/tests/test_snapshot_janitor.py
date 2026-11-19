"""deploy/aws/e2b/snapshot-janitor.sh: a build any kept build is layered on is never deleted, however many layers
down, and a header the janitor cannot read deletes nothing.

Runs the real script against a fabricated store, with `docker` stubbed to answer the database query. Header bytes
follow e2b-dev/infra packages/shared/pkg/storage/header: 64 bytes of metadata (four LE uint64s, BuildId,
BaseBuildId), then V3's 40-byte mappings, or V4's flags byte, uint32 size and an LZ4 frame.
"""
import os
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "aws" / "e2b" / "snapshot-janitor.sh"
OLD = time.time() - 3 * 3600

KEPT = "aaaaaaaa-0000-4000-8000-000000000001"
PARENT = "bbbbbbbb-0000-4000-8000-000000000002"
GRANDPARENT = "cccccccc-0000-4000-8000-000000000003"
ORPHAN = "dddddddd-0000-4000-8000-000000000004"


def metadata(version, build, base):
    return struct.pack("<QQQQ16s16s", version, 4096, 1 << 30, 1, uuid.UUID(build).bytes, uuid.UUID(base).bytes)


def v3_header(build, base, *layers):
    maps = b"".join(struct.pack("<QQ16sQ", i * 4096, 4096, uuid.UUID(b).bytes, 0) for i, b in enumerate(layers))
    return metadata(3, build, base) + maps


def v4_header(build, base, *layers):
    import lz4.frame

    block = struct.pack("<I", len(layers)) + b"".join(uuid.UUID(b).bytes + b"\0" * 48 for b in layers)
    return metadata(4, build, base) + struct.pack("<BI", 0, len(block)) + lz4.frame.compress(block)


NO_HEADER = object()  # the layer's data file is written and its header is not


def add_build(store, cache, build, rootfs_header=None, memfile_header=None):
    """A build directory with a data file for each layer given a header (None: no such layer)."""
    d = store / "templates" / build
    d.mkdir(parents=True)
    for layer, header in (("rootfs.ext4", rootfs_header), ("memfile", memfile_header)):
        if header is None:
            continue
        (d / layer).write_bytes(b"x" * 2048)
        if header is not NO_HEADER:
            (d / f"{layer}.header").write_bytes(header)
    (store / "build-cache" / build).mkdir(parents=True)
    (cache / f"{build}-rootfs.ext4-0").write_bytes(b"c")
    for p in [*d.iterdir(), d, store / "build-cache" / build, cache / f"{build}-rootfs.ext4-0"]:
        os.utime(p, (OLD, OLD))


def run(tmp_path, live, extra_env=None):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' " + " ".join(live) + "\n")
    docker.chmod(0o755)
    env = {
        **os.environ,
        # This interpreter's own directory first, so the script's python3 sees the modules the test does.
        "PATH": f"{bin_dir}:{Path(sys.executable).parent}:{os.environ['PATH']}",
        "JANITOR_STORE": str(tmp_path / "store"),
        "JANITOR_CACHE": str(tmp_path / "cache"),
        **(extra_env or {}),
    }
    return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, check=True)


def present(tmp_path, build):
    return (tmp_path / "store" / "templates" / build).exists()


@pytest.fixture
def dirs(tmp_path):
    store, cache = tmp_path / "store", tmp_path / "cache"
    (store / "templates").mkdir(parents=True)
    (store / "build-cache").mkdir()
    cache.mkdir()
    return store, cache


def test_keeps_every_build_a_kept_build_is_layered_on_and_logs_each_deletion(tmp_path, dirs):
    store, cache = dirs
    add_build(store, cache, KEPT, v3_header(KEPT, KEPT, KEPT, PARENT), v3_header(KEPT, KEPT, KEPT))
    # The grandparent is named only in the parent's header, so finding it needs the parent kept first.
    add_build(store, cache, PARENT, v3_header(PARENT, PARENT, PARENT), v3_header(PARENT, PARENT, GRANDPARENT))
    add_build(store, cache, GRANDPARENT, v3_header(GRANDPARENT, GRANDPARENT, GRANDPARENT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN), v3_header(ORPHAN, ORPHAN, ORPHAN))

    out = run(tmp_path, [KEPT]).stdout

    for build in (KEPT, PARENT, GRANDPARENT):
        assert present(tmp_path, build), out
        assert (store / "build-cache" / build).exists()
        assert (cache / f"{build}-rootfs.ext4-0").exists()
    assert not present(tmp_path, ORPHAN)
    assert not (store / "build-cache" / ORPHAN).exists()
    assert not (cache / f"{ORPHAN}-rootfs.ext4-0").exists()
    assert f"keeping {PARENT}, a kept build is layered on it" in out
    assert f"keeping {GRANDPARENT}, a kept build is layered on it" in out
    deleted = [line for line in out.splitlines() if "deleted build" in line]
    assert len(deleted) == 3 and all(f"deleted build {ORPHAN}:" in line for line in deleted), out


def test_dry_run_deletes_nothing_and_names_what_it_would_delete(tmp_path, dirs):
    store, cache = dirs
    add_build(store, cache, KEPT, v3_header(KEPT, KEPT, KEPT, PARENT))
    add_build(store, cache, PARENT, v3_header(PARENT, PARENT, PARENT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))

    out = run(tmp_path, [KEPT], {"JANITOR_DRY_RUN": "1"}).stdout

    assert present(tmp_path, ORPHAN)
    assert f"would delete build {ORPHAN}:" in out
    assert f"would delete build {PARENT}" not in out


def test_young_orphans_are_left_alone(tmp_path, dirs):
    store, cache = dirs
    add_build(store, cache, KEPT, v3_header(KEPT, KEPT, KEPT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))
    now = time.time()
    os.utime(store / "templates" / ORPHAN, (now, now))

    run(tmp_path, [KEPT])

    assert present(tmp_path, ORPHAN)


@pytest.mark.parametrize(
    "rootfs_header",
    [
        NO_HEADER,  # a kept build with rootfs data and no rootfs header
        b"\x03" + b"\0" * 10,  # shorter than its metadata
        metadata(9, KEPT, KEPT),  # a version this janitor does not know
        metadata(4, KEPT, KEPT) + struct.pack("<BI", 0, 64) + b"not an lz4 frame",
    ],
    ids=["missing", "truncated", "unknown-version", "bad-lz4"],
)
def test_a_kept_header_it_cannot_read_deletes_nothing(tmp_path, dirs, rootfs_header):
    store, cache = dirs
    add_build(store, cache, KEPT, rootfs_header, v3_header(KEPT, KEPT, KEPT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))

    out = run(tmp_path, [KEPT]).stdout

    assert present(tmp_path, ORPHAN)
    assert "deleting nothing" in out
    assert "deleted build" not in out


def test_v4_header_parent_inside_the_lz4_frame_is_kept(tmp_path, dirs):
    pytest.importorskip("lz4.frame")
    store, cache = dirs
    add_build(store, cache, KEPT, v4_header(KEPT, KEPT, KEPT, PARENT))
    add_build(store, cache, PARENT, v3_header(PARENT, PARENT, PARENT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))

    out = run(tmp_path, [KEPT]).stdout

    assert present(tmp_path, PARENT), out
    assert not present(tmp_path, ORPHAN)


def test_v4_header_without_the_lz4_module_deletes_nothing(tmp_path, dirs):
    pytest.importorskip("lz4.frame")
    store, cache = dirs
    add_build(store, cache, KEPT, v4_header(KEPT, KEPT, KEPT, PARENT))
    add_build(store, cache, PARENT, v3_header(PARENT, PARENT, PARENT))
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))
    shadow = tmp_path / "no-lz4" / "lz4"
    shadow.mkdir(parents=True)
    (shadow / "__init__.py").write_text("raise ImportError('lz4 hidden by the test')\n")

    out = run(tmp_path, [KEPT], {"PYTHONPATH": str(shadow.parent)}).stdout

    assert present(tmp_path, ORPHAN) and present(tmp_path, PARENT)
    assert "deleting nothing" in out


def test_an_unreadable_database_deletes_nothing(tmp_path, dirs):
    store, cache = dirs
    add_build(store, cache, ORPHAN, v3_header(ORPHAN, ORPHAN, ORPHAN))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "docker").write_text("#!/bin/sh\nexit 1\n")
    (bin_dir / "docker").chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "JANITOR_STORE": str(store),
           "JANITOR_CACHE": str(cache)}

    out = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, check=True).stdout

    assert present(tmp_path, ORPHAN)
    assert "database unreadable, deleting nothing" in out
