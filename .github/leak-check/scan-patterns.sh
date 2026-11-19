#!/usr/bin/env bash
# Sourced, not run. The one reader of forbidden.tsv and allow.tsv: check-new-lines.sh (added lines of
# files) and ../public-text-check.sh (commit and PR text) both call scan_patterns, so a pattern added
# to forbidden.tsv guards both.
#
#   scan_patterns <cfg-dir> <dir-to-search> <use-allow: 1|0> [<forbidden.tsv>]
#
# The pattern file defaults to <cfg-dir>/forbidden.tsv. The public repo passes its own path, because it
# holds the list in a CI secret rather than in the tree (the list names people and hosts).
#
# Prints one `FAIL|WARN  <pattern name>  <file>:<line>:<text>` row per hit and sets scan_fail=1 when a
# non-warn pattern hit. Returns 2 when rg could not run. allow.tsv holds path globs, so text with no
# path (use-allow 0) is checked against every pattern.
scan_patterns() {
	local cfg=$1 dir=$2 use_allow=$3 patterns=${4:-$1/forbidden.tsv} name pat level an apath tag hits rc globs err
	err=$(mktemp)
	scan_fail=0
	while IFS=$'\t' read -r name pat level; do
		case "$name" in '' | '#'*) continue ;; esac
		globs=()
		if [ "$use_allow" = 1 ]; then
			while IFS=$'\t' read -r an apath _; do
				if [ "$an" = "$name" ]; then globs+=(-g "!$apath"); fi
			done < <(grep -v '^[[:space:]]*\(#\|$\)' "$cfg/allow.tsv")
		fi
		rc=0
		hits=$(cd "$dir" && rg -n --hidden --no-ignore -P "${globs[@]}" -- "$pat" . 2> "$err") || rc=$?
		if [ "$rc" -ge 2 ]; then
			# rg's error quotes the pattern, so a list kept out of the tree is not echoed into a public log.
			if [ "$patterns" = "$cfg/forbidden.tsv" ]; then
				echo "scan-patterns: rg could not run for $name: $(head -3 "$err" | tr '\n' ' ')" >&2
			else
				echo "scan-patterns: rg could not run for $name (pattern not shown)" >&2
			fi
			rm -f "$err"
			return 2
		fi
		[ -n "$hits" ] || continue
		if [ "$level" = "warn" ]; then tag=WARN; else tag=FAIL; scan_fail=1; fi
		printf '%s\n' "$hits" | sed "s#^\./##; s#^#$tag  $name  #" | cut -c1-240
	done < "$patterns"
	rm -f "$err"
	return 0
}
