#!/usr/bin/env bash
# Is the app that came back the one we just deployed, and can it still serve a task?
#
# A deploy that only prints /healthz afterwards cannot fail: an app that never came back exits 0, and an
# app that came back on the old image reads exactly like a good one, because nothing compares `build`
# with the SHA just deployed. This script is the check that can fail.
#
# THREE THINGS, IN THIS ORDER, because each is meaningless without the one before it:
#
#   1. /healthz answers at all                  — the machine booted
#   2. /healthz.build == the SHA we deployed    — it booted THIS code, not the last image
#   3. the probes pass                          — this code actually serves a task
#
# Step 2 is the one with no substitute. A rolling deploy answers from the outgoing machine for a while,
# so this POLLS for the expected SHA rather than reading once and comparing: a single read that lands
# early is indistinguishable from a deploy that never took, and the difference is the whole question.
# On timeout it prints the build it kept seeing, which is what tells the two apart afterwards.
#
# Deliberately NOT a rollback. Fly can roll back (`fly releases` + a redeploy of the prior image), and
# a failing job tells a human to do that. Rolling back automatically needs its own definition of
# "healthy" during a rolling deploy, which this check does not try to settle.
#
#   AGENT_APP=<fly app> fly/verify-deploy.sh               # after a deploy, from the same checkout
#   AGENT_APP=<fly app> fly/verify-deploy.sh --no-probes   # steps 1-2 only, no model spend (local iteration)
#   AGENT_BASE=https://<agent host> EXPECT_SHA=abc1234 fly/verify-deploy.sh
#
# AGENT_BASE is the service's address; AGENT_APP alone means https://<app>.fly.dev. One of them is required: the
# script names no deployment of its own.
# AGENT_SMOKE_TOKEN is needed for step 3 only; --no-probes runs without it.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=${AGENT_APP:-}
if [ -z "${AGENT_BASE:-}" ] && [ -z "$APP" ]; then
    echo "FAIL: set AGENT_BASE to the service's address, or AGENT_APP to its Fly app name." >&2
    exit 2
fi
BASE=${AGENT_BASE:-https://$APP.fly.dev}
# Computed the same way the deploy stamps GIT_SHA, from the same checkout. `git rev-parse --short` picks a
# length that makes the hash unambiguous IN THIS OBJECT DATABASE — 7 for one commit here today, 10 for
# another, and shorter again in CI's shallow clone. So the comparison below is prefix-based rather than
# string equality: a gate that false-fails on an abbreviation length would block a healthy deploy, and a
# gate that cries wolf is one people learn to ignore.
EXPECT=${EXPECT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}
FULL=${EXPECT_FULL_SHA:-$(git rev-parse HEAD 2>/dev/null || echo "")}
DEADLINE_S=${VERIFY_DEADLINE_S:-240}
PY=${PYBIN:-python3}
PROBES=1
[ "${1:-}" = "--no-probes" ] && PROBES=0

if [ "$EXPECT" = "unknown" ]; then
    echo "FAIL: cannot determine the expected SHA (not a git checkout, and EXPECT_SHA unset)." >&2
    echo "      Verifying against 'unknown' would pass on any image at all." >&2
    exit 2
fi

# A build stamped from a tree with uncommitted changes carries `-dirty`. That is a real fact about the
# image and is preserved in the reported value, but it must not break the prefix match.
_matches() {
    local got=${1%-dirty}
    [ ${#got} -ge 7 ] || return 1
    [ "$got" = "$EXPECT" ] && return 0
    [ -n "$FULL" ] && [ "${FULL#"$got"}" != "$FULL" ] && return 0
    return 1
}

echo "==> waiting for $BASE to report build=$EXPECT (deadline ${DEADLINE_S}s)"
deadline=$(( $(date +%s) + DEADLINE_S ))
seen=""
while [ "$(date +%s)" -lt "$deadline" ]; do
    # `|| true` covers the pipeline only: a connection refused mid-boot is expected and must not end
    # the loop. The deadline is what ends it, and never matching is a failure — unlike the print this
    # replaces, no branch here reports success without having seen the SHA.
    got="$(curl -s --max-time 15 "$BASE/healthz" \
        | "$PY" -c 'import json,sys; print(json.load(sys.stdin).get("build") or "")' 2>/dev/null || true)"
    if [ -n "$got" ]; then
        seen="$got"
        _matches "$got" && break
    fi
    sleep 5
done

# Two different failures with two different next reads, so they get two different messages. Collapsing
# them sends whoever is paged to `fly releases` when the actual problem is that nothing is listening.
if [ -z "$seen" ]; then
    echo "FAIL: $BASE never answered /healthz within ${DEADLINE_S}s." >&2
    echo "      Nothing is serving — check the app is up and the hostname is right before the image:" >&2
    echo "      \`fly status -a $APP\` and \`fly logs -a $APP\`." >&2
    exit 1
fi
if ! _matches "$seen"; then
    echo "FAIL: $BASE is serving build=$seen after ${DEADLINE_S}s, expected $EXPECT." >&2
    echo "      It answered, so it is up — it is running the WRONG code. The deploy did not take." >&2
    echo "      \`fly releases -a $APP\` shows whether a new image was ever created." >&2
    exit 1
fi
echo "    build=$seen confirmed"

if [ "$PROBES" = "0" ]; then
    echo "==> --no-probes: the deployed code was never asked to serve a task."
    exit 0
fi

if [ -z "${AGENT_SMOKE_TOKEN:-}" ]; then
    echo "FAIL: AGENT_SMOKE_TOKEN unset, so steps 1-2 passed and nothing exercised the service." >&2
    echo "      Run under \`doppler run\` with the stack's agent-service config," >&2
    echo "      or pass --no-probes to say so." >&2
    exit 2
fi

echo "==> one spec'd task (prod_smoke.py)"
if ! "$PY" scripts/prod_smoke.py --base "$BASE"; then
    echo "==> first attempt failed — retrying once before failing the deploy." >&2
    echo "    A fresh task against the same deployed code; two failures in a row is real signal," >&2
    echo "    one is as likely to be transient model-side flakiness as a regression." >&2
    "$PY" scripts/prod_smoke.py --base "$BASE"
fi

echo "==> wall-clock anchor + deadline fidelity (date_anchor_probe.py)"
# Reported, never blocking. The probe exists to catch a Hermes bump that drops the date line, and
# test_the_wall_clock_anchor_is_inherited_from_hermes_not_owned_here already forces a rerun on every
# HERMES_SHA change. As a deploy gate it would fail unrelated changes over the model's own date
# mistakes.
date_rc=0
"$PY" scripts/date_anchor_probe.py --base "$BASE" -k 3 --min-pass 2 || date_rc=$?
if [ "$date_rc" -ne 0 ]; then
    echo "::warning::date_anchor_probe.py exited $date_rc on build=$EXPECT; not blocking the deploy."
fi

echo "==> the chat surface's own shape: no spec, auto mode, a Word and an Excel file (chat_file_probe.py)"
# prod_smoke.py passes a spec and answers every card, so it can stay green while chat's spec-less,
# auto-mode file tasks answer "I was not able to complete this" over a delivered file. This probe drives
# that shape. It is reported, not blocking, until CI runs show it fails for that reason and nothing else.
chat_rc=0
"$PY" scripts/chat_file_probe.py --base "$BASE" -k 1 --min-pass 1 || chat_rc=$?
if [ "$chat_rc" -ne 0 ]; then
    echo "::warning::chat_file_probe.py exited $chat_rc on build=$EXPECT; not blocking the deploy yet."
fi

echo
echo "PASS: $BASE serves build=$EXPECT and completed the smoke task (date probe exit $date_rc, chat file probe exit $chat_rc)."
