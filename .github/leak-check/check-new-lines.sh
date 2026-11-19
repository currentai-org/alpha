#!/usr/bin/env bash
# Check the lines a change adds to files the public snapshot ships, with the export's own content
# patterns, so a leak is caught on the commit that writes it instead of at the next export.
#
#   scripts/public-snapshot/check-new-lines.sh <base-ref> [<head-ref>]
#   scripts/public-snapshot/check-new-lines.sh --full [<head-ref>]    # every line of every shipped file
#   scripts/public-snapshot/check-new-lines.sh --staged               # lines staged for the next commit (pre-commit)
#
# Shipped means what export-public-snapshot.sh steps 1 and 2 keep: allowlist.txt, then exclude.txt.
# Only added lines are checked (git diff <base>...<head>), so text already in the tree does not fail a
# change that did not write it; the export itself still scans the whole tree. forbidden.tsv and
# allow.tsv are read exactly as the export reads them: a `warn` pattern reports, any other fails.
# Exit 0 clean, 1 on a finding, 2 when it could not run.
#
# The public repo runs this same script from .github/leak-check/, where there is no allowlist.txt: its
# tree already is the shipped tree, so every changed file is checked. There the patterns come from a CI
# secret, named by LEAK_CHECK_PATTERNS, and LEAK_CHECK_REPO names the checkout when the script runs from
# a copy outside it.
set -euo pipefail
export LC_ALL=C

base=${1:?usage: check-new-lines.sh <base-ref> [<head-ref>]}
head=${2:-HEAD}
staged=0
here=$(cd "$(dirname "$0")" && pwd)
repo=${LEAK_CHECK_REPO:-$(git -C "$here" rev-parse --show-toplevel)}
cfg=$here
patterns=${LEAK_CHECK_PATTERNS:-$cfg/forbidden.tsv}
[ -s "$patterns" ] || { echo "check-new-lines: no pattern file at $patterns" >&2; exit 2; }
command -v rg > /dev/null || { echo "check-new-lines: rg not found" >&2; exit 2; }
rg -P --version > /dev/null 2>&1 || { echo "check-new-lines: rg lacks PCRE2" >&2; exit 2; }
if [ "$base" = "--staged" ]; then
	# The index as a tree, diffed against HEAD with two dots (a tree has no merge base).
	git -C "$repo" diff --cached --quiet && exit 0
	staged=1
	base=HEAD
	head=$(git -C "$repo" write-tree)
fi

if [ "$base" = "--full" ]; then range=("$(git -C "$repo" hash-object -t tree /dev/null)" "$head"); elif [ "$staged" = 1 ]; then range=("$base" "$head")
else range=("$base...$head"); fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tree=$work/tree
mirror=$work/added
mkdir -p "$tree" "$mirror"

shopt -s globstar dotglob nullglob extglob
if [ -f "$cfg/allowlist.txt" ]; then
	# Steps 1 and 2 of the export, against <head>.
	mapfile -t specs < <(grep -v '^[[:space:]]*\(#\|$\|+\)' "$cfg/allowlist.txt")
	# A `+` re-include names one file. git archive fails on a pathspec that matches nothing, so a file
	# <head> does not hold (deleted, or a tree that exclude.txt already pruned) is skipped, not fatal.
	extra=()
	while IFS= read -r f; do
		if git -C "$repo" cat-file -e "$head:$f" 2> /dev/null; then extra+=("$f"); fi
	done < <(grep '^+' "$cfg/allowlist.txt" | cut -c2-)
	# Extract only the changed files that the allowlist keeps: the added lines are all that is checked, and
	# unpacking the whole of web/ for a one-line change took ten seconds in the pre-commit hook.
	mapfile -t changed < <(git -C "$repo" diff --name-only --diff-filter=AM --no-renames "${range[@]}" -- "${specs[@]}" ${extra[@]+"${extra[@]}"})
	if [ "${#changed[@]}" -gt 0 ]; then git -C "$repo" archive --format=tar "$head" -- "${changed[@]}" | tar -x -C "$tree"; fi
	(
		cd "$tree"
		while IFS= read -r glob; do
			case "$glob" in '' | '#'*) continue ;; esac
			for p in $glob; do rm -rf -- "$p"; done
		done < "$cfg/exclude.txt"
	)
fi

# For each changed file that ships, a copy holding only its added lines, at their own line numbers.
# A path overlay/ replaces ships the overlay's copy, not the repo's, so the repo's lines are not checked;
# lines added to the overlay copy are checked instead, at the path they ship to.
if [ -f "$cfg/allowlist.txt" ]; then
	(cd "$tree" && find . -type f -printf '%P\n') | sort > "$work/tree-files"
else
	git -C "$repo" ls-tree -r --name-only "$head" | sort > "$work/tree-files"
fi
(cd "$cfg/overlay" 2> /dev/null && find . -type f -printf '%P\n' || true) | sort > "$work/overlay-files"
comm -23 "$work/tree-files" "$work/overlay-files" > "$work/shipped"
git -C "$repo" diff -U0 --no-color --no-ext-diff --no-renames --diff-filter=AM "${range[@]}" > "$work/diff"
# One pass over the whole diff: a `+++ b/<path>` line opens a file, `@@ -a +c,d @@` sets the line
# number, and each `+` line is kept at that number. Paths with spaces or quoting are skipped.
n=$(awk -v mirror="$mirror" '
	function flush(   i, dir) {
		if (cur == "" || max == 0) return
		dir = mirror "/" cur; sub(/\/[^\/]*$/, "", dir); system("mkdir -p \"" dir "\"")
		for (i = 1; i <= max; i++) print ((i in line) ? line[i] : "") > (mirror "/" cur)
		close(mirror "/" cur); files++
	}
	NR == FNR { ship[$0] = 1; next }
	/^diff --git / { flush(); cur = ""; max = 0; delete line; next }
	/^\+\+\+ / {
		p = substr($0, 5); cur = ""
		if (p ~ /^b\/scripts\/public-snapshot\/overlay\//) cur = substr(p, 3 + length("scripts/public-snapshot/overlay/"))
		else if (p ~ /^b\// && (substr(p, 3) in ship)) cur = substr(p, 3)
		next
	}
	/^@@/ { split($3, a, ","); ln = substr(a[1], 2) + 0; next }
	cur != "" && /^\+/ { line[ln] = substr($0, 2); if (ln > max) max = ln; ln++ }
	END { flush(); print files + 0 }' "$work/shipped" "$work/diff")

# PCRE2 stops with "match limit exceeded" on a pattern like `#.*\bword\b` over a multi-megabyte line, so
# an added JSON line over 1 MB is scanned as the export scans it: from a pretty-printed copy, one value
# per line (expand-huge-json.mjs), with hits reported at the copy's line numbers. Any other line that
# long still makes rg fail, and the check exits 2.
if [ -n "$(find "$mirror" -type f -name '*.json' -size +1000000c -print -quit)" ]; then
	command -v node > /dev/null || { echo "check-new-lines: node not found (needed for an added JSON line over 1 MB)" >&2; exit 2; }
	huge=$(node "$here/expand-huge-json.mjs" "$mirror" "$work/expanded") || { echo "check-new-lines: expand-huge-json.mjs failed" >&2; exit 2; }
	while IFS= read -r rel; do
		[ -z "$rel" ] || mv -f "$work/expanded/$rel" "$mirror/$rel"
	done <<< "$huge"
fi

# shellcheck source=scan-patterns.sh
. "$here/scan-patterns.sh"
rc=0
scan_patterns "$cfg" "$mirror" 1 "$patterns" || rc=$?
[ "$rc" -eq 0 ] || exit "$rc"
fail=$scan_fail

echo "check-new-lines: $n shipped file(s) with added lines checked against $base" >&2
exit "$fail"
