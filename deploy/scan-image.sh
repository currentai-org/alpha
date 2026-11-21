#!/usr/bin/env bash
# Scans a built image's filesystem for secrets with gitleaks and fails when it finds one. This reads what
# ships, not the source tree: a file COPYed in by a build stage is covered even when no source scan sees it.
#
#   deploy/scan-image.sh <image reference>      # a tag or name@sha256:digest
#
# Needs docker. GITLEAKS_IMAGE overrides the pinned scanner image.
set -euo pipefail

image="${1:?usage: scan-image.sh <image reference>}"
here="$(cd "$(dirname "$0")" && pwd)"
GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f}"

work=$(mktemp -d)
container=""
cleanup() {
	[ -z "$container" ] || docker rm -f "$container" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

mkdir "$work/fs" "$work/out"
chmod 777 "$work/out"
container=$(docker create "$image")
# A failed export or extraction is a failed scan: a half-read filesystem must never read as clean.
set -o pipefail
docker export "$container" | tar -x -C "$work/fs" --no-same-owner --no-same-permissions \
	|| { echo "scan-image: could not export $image to a directory" >&2; exit 1; }
files=$(find "$work/fs" -type f | wc -l)
[ "$files" -gt 0 ] || { echo "scan-image: nothing extracted from $image" >&2; exit 1; }
echo "scan-image: scanning $files files from $image"

# gitleaks prints no finding itself (no --verbose). The JSON report stays in the scratch directory, which
# is deleted on exit, and the summary below prints each match with its secret replaced by its length and
# character classes, so a log says what kind of value fired without carrying it.
set +e
docker run --rm -v "$work/fs:/scan:ro" -v "$work/out:/out" -v "$here/gitleaks-image.toml:/config.toml:ro" "$GITLEAKS_IMAGE" \
	dir /scan --config /config.toml --no-banner \
	--report-format json --report-path /out/report.json --exit-code 1
code=$?
set -e
if [ "$code" != 0 ] && [ -s "$work/out/report.json" ] && command -v jq >/dev/null; then
	echo "scan-image: findings by rule" >&2
	jq -r '.[].RuleID' "$work/out/report.json" | sort | uniq -c | sort -rn >&2
	echo "scan-image: findings by file and line (the first 40)" >&2
	jq -r '.[] | . as $f | ($f.Secret | "<len=\(length) \(if test("[a-z]") then "a" else "" end)\(if test("[A-Z]") then "A" else "" end)\(if test("[0-9]") then "0" else "" end)\(if test("[-_]") then "-" else "" end)\(if test("[^A-Za-z0-9_-]") then "." else "" end)>") as $shape | "\($f.RuleID) \($f.File | sub("^/scan/";"")):\($f.StartLine) \($f.Match | split($f.Secret) | join($shape) | .[0:140])"' "$work/out/report.json" | awk 'NR<=40' >&2
	echo "scan-image: findings by directory (first four path parts under the image root)" >&2
	jq -r '.[].File | sub("^/scan/";"") | split("/")[0:4] | join("/")' "$work/out/report.json" | sort | uniq -c | sort -rn | awk 'NR<=40' >&2
fi
[ "$code" = 0 ] || exit "$code"
echo "scan-image: clean"
