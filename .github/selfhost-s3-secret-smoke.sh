#!/usr/bin/env bash
# The s3 profile's SeaweedFS (selfhost/compose.yaml) refuses a blank key pair, and leaving the profile out
# needs no key at all. Starts only that service, from env files this script writes, and fails unless:
#   - compose renders the file and runs `down` with no S3 key set, with and without the profile, so the
#     refusal is not a `${VAR:?}` that would stop every command for people who never use S3;
#   - SeaweedFS started with block S's key and a blank secret exits non-zero and prints how to make one
#     (`openssl rand -hex 32`), and `up --wait` on it fails;
#   - SeaweedFS started with the key and a secret comes up healthy;
#   - SeaweedFS started with only FILES_ACCESS_KEY and FILES_SECRET_KEY (deploy/'s names for the pair)
#     comes up healthy, holding them as its AWS_* identity.
# Run from the repository root by the self-host CI workflow (job s3-secret). No secret, no model, one
# image pulled.
set -euo pipefail

cd "$(dirname "$0")/../selfhost"
project=alpha-s3-secret-smoke
work=$(mktemp -d)
# compose.yaml requires this for the web service; nothing here starts web.
base="BETTER_AUTH_SECRET=unused-by-this-check"
compose() { docker compose -p "$project" --env-file "$work/env" "$@"; }
with_env() { printf '%s\n' "$base" "$@" >"$work/env"; }

# The web service's env_file; an operator always has one, and its contents do not matter here.
made_dotenv=0
if [ ! -e .env ]; then
	: >.env
	made_dotenv=1
fi

cleanup() {
	with_env
	compose --profile s3 down -v >/dev/null 2>&1 || true
	rm -rf "$work"
	if [ "$made_dotenv" -eq 1 ]; then rm -f .env; fi
}
trap cleanup EXIT

fail=0
pass() { echo "PASS $*"; }
flunk() { echo "FAIL $*"; fail=1; }

# 1. No S3 key anywhere: the commands a non-S3 operator runs still work.
with_env
for profiles in "" "--profile s3"; do
	# shellcheck disable=SC2086
	if out=$(compose $profiles config --quiet 2>&1) && out2=$(compose $profiles down 2>&1); then
		pass "no S3 key, ${profiles:-no profile}: config and down succeed"
	else
		flunk "no S3 key, ${profiles:-no profile}: compose refused: $out ${out2:-}"
	fi
done

# 2. Block S's key with a blank secret, as .env.example ships it uncommented.
with_env "AWS_ACCESS_KEY_ID=alpha" "AWS_SECRET_ACCESS_KEY="
set +e
out=$(compose --profile s3 run --rm --no-deps -T seaweedfs 2>&1)
code=$?
set -e
echo "blank secret: seaweedfs exited $code"
printf '%s\n' "$out" | grep '^seaweedfs:' || true
if [ "$code" -eq 0 ]; then
	flunk "blank secret: seaweedfs exited 0"
elif ! printf '%s\n' "$out" | grep -q 'openssl rand -hex 32'; then
	flunk "blank secret: seaweedfs exited $code without saying how to make a secret: $out"
else
	pass "blank secret: seaweedfs exited $code and named openssl rand -hex 32"
fi
if compose --profile s3 up -d --wait --wait-timeout 60 seaweedfs >/dev/null 2>&1; then
	flunk "blank secret: up --wait reported seaweedfs healthy"
else
	pass "blank secret: up --wait failed"
fi
compose --profile s3 down -v >/dev/null 2>&1 || true

# 3. The key and a secret.
with_env "AWS_ACCESS_KEY_ID=alpha" "AWS_SECRET_ACCESS_KEY=$(openssl rand -hex 32)"
if compose --profile s3 up -d --wait --wait-timeout 180 seaweedfs; then
	pass "keyed: seaweedfs healthy"
else
	flunk "keyed: seaweedfs did not come up healthy"
	compose --profile s3 logs --no-color --tail 40 seaweedfs || true
fi
compose --profile s3 down -v >/dev/null 2>&1 || true

# 4. Only deploy/'s names for the pair.
secret=$(openssl rand -hex 32)
with_env "FILES_ACCESS_KEY=alpha" "FILES_SECRET_KEY=$secret"
if compose --profile s3 up -d --wait --wait-timeout 180 seaweedfs; then
	held=$(compose --profile s3 exec -T seaweedfs printenv AWS_SECRET_ACCESS_KEY || true)
	if [ "$held" = "$secret" ]; then
		pass "FILES_* alias: seaweedfs healthy, holding FILES_SECRET_KEY as AWS_SECRET_ACCESS_KEY"
	else
		flunk "FILES_* alias: seaweedfs healthy, but its AWS_SECRET_ACCESS_KEY is not FILES_SECRET_KEY"
	fi
else
	flunk "FILES_* alias: seaweedfs did not come up healthy"
	compose --profile s3 logs --no-color --tail 40 seaweedfs || true
fi

if [ "$fail" -ne 0 ]; then
	echo "S3 SECRET SMOKE FAIL"
	exit 1
fi
echo "S3 SECRET SMOKE PASS"
