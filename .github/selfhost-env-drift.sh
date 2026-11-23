#!/usr/bin/env bash
# Drift between selfhost/.env.example and the compose files, both ways:
#   - a `${NAME}` a selfhost/compose*.yaml file reads that .env.example never mentions, so a self-hoster
#     cannot find the setting (AGENT_MODEL was one);
#   - a key .env.example offers that no compose file reads and the web app does not declare in
#     web/config/env-manifest.mjs, so setting it does nothing. The web service loads all of .env
#     (`env_file`), so a key the web app reads needs no compose line.
# A key commented out in .env.example (`# NAME=`) counts as mentioned. Then `docker compose config -q`
# must render for each profile, and for the GPU override, with nothing but a placeholder
# BETTER_AUTH_SECRET.
#
#   .github/selfhost-env-drift.sh
#
# Prints one `DRIFT` line per finding and `ENV DRIFT PASS` or `ENV DRIFT FAIL`; exits 1 on any finding.
# Needs docker compose and grep. Reads no secret and starts nothing.
set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."
root=$(pwd)

example=selfhost/.env.example
manifest=web/config/env-manifest.mjs
[ -f "$example" ] || { echo "ENV DRIFT FAIL: $example is missing"; exit 1; }
[ -f "$manifest" ] || { echo "ENV DRIFT FAIL: $manifest is missing"; exit 1; }
work=$(mktemp -d)
made_env=""
cleanup() { rm -rf "$work"; [ -z "$made_env" ] || rm -f "$root/selfhost/.env"; }
trap cleanup EXIT
findings=0

# Every ${NAME...} on a non-comment line of a compose file. `$$` escapes a literal dollar for the shell
# inside the container, so `$${NAME}` is the container's own variable and is skipped.
for f in selfhost/compose*.yaml; do
	grep -v '^[[:space:]]*#' "$f" | sed 's/\$\$[{]*[A-Za-z_][A-Za-z0-9_]*//g' \
		| grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | cut -c3- || true
done | sort -u >"$work/compose"
grep -oE '^#?[[:space:]]*[A-Z][A-Z0-9_]*=' "$example" | sed -E 's/^#?[[:space:]]*//; s/=$//' | sort -u >"$work/example"
grep -oE '^[[:space:]]+[A-Z][A-Z0-9_]*: \{' "$manifest" | sed -E 's/^[[:space:]]+//; s/: \{$//' | sort -u >"$work/manifest"
sort -u "$work/compose" "$work/manifest" >"$work/read"

while read -r name; do
	echo "DRIFT: compose reads \${$name}; $example never mentions it"
	findings=$((findings + 1))
done < <(comm -23 "$work/compose" "$work/example")
while read -r name; do
	echo "DRIFT: $example offers $name; no compose file reads it and $manifest does not declare it"
	findings=$((findings + 1))
done < <(comm -23 "$work/example" "$work/read")
echo "ok   $(wc -l <"$work/compose") compose variables, $(wc -l <"$work/example") .env.example keys compared"

# compose reads selfhost/.env (env_file) and refuses to render without one; a fresh checkout has none,
# so the example stands in for it and is removed again on exit.
if [ ! -e selfhost/.env ]; then
	cp "$example" selfhost/.env
	made_env=1
fi
cd selfhost
export BETTER_AUTH_SECRET=env-drift-placeholder
set -f # `--profile *` is compose's every-profile wildcard, not a file glob
for args in "" "--profile local" "--profile s3" "--profile agent" "--profile safety" "--profile *" \
	"-f compose.yaml -f compose.gpu.yaml --profile local"; do
	# shellcheck disable=SC2086 # split on purpose: each entry is several arguments
	if docker compose $args config -q >"$work/config.err" 2>&1; then
		echo "ok   docker compose ${args:-(no profile)} config renders"
	else
		echo "DRIFT: docker compose ${args:-(no profile)} config fails: $(head -c 300 "$work/config.err")"
		findings=$((findings + 1))
	fi
done

if [ "$findings" -gt 0 ]; then
	echo "ENV DRIFT FAIL: $findings finding(s)"
	exit 1
fi
echo "ENV DRIFT PASS"
