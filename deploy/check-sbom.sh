#!/usr/bin/env bash
# Reads an image's SBOM back from the registry and fails when it is missing or lists no package, so an empty
# SBOM is never signed. buildx stores the SBOM as an attestation on each platform of the index; this reads
# it the way a consumer would (`docker buildx imagetools inspect --format '{{ json .SBOM }}'`).
#
#   deploy/check-sbom.sh <name@sha256:digest> [expected platform count, default 2]
#
# Needs docker buildx and jq. Prints one line per platform with its SPDX package count.
set -euo pipefail

image="${1:?usage: check-sbom.sh <image reference> [expected platform count]}"
want="${2:-2}"

sbom=$(docker buildx imagetools inspect "$image" --format '{{ json .SBOM }}')
# A platform with no SBOM is absent from the map (or the map is null): both read as zero packages.
counts=$(printf '%s' "$sbom" | jq -r 'if type == "object" then to_entries[] | "\(.key)\t\((.value.SPDX.packages // []) | length)" else empty end')
if [ -z "$counts" ]; then
	echo "check-sbom: $image carries no SBOM" >&2
	exit 1
fi
printf '%s\n' "$counts" | while IFS=$'\t' read -r platform n; do echo "check-sbom: $platform lists $n packages"; done
platforms=$(printf '%s\n' "$counts" | wc -l)
if [ "$platforms" -lt "$want" ]; then
	echo "check-sbom: expected an SBOM for $want platforms, found $platforms" >&2
	exit 1
fi
if printf '%s\n' "$counts" | awk -F'\t' '$2 < 1 { bad = 1 } END { exit !bad }'; then
	echo "check-sbom: a platform's SBOM lists no packages" >&2
	exit 1
fi
echo "check-sbom: ok"
