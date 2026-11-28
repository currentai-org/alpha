#!/usr/bin/env bash
# A stranger's walk of the top-level README: run the commands between its readme-walk markers, in order,
# from an empty directory, then the command between its readme-walk-answer markers, and time each one.
# Nothing here knows the commands: change the README and this runs the new ones. Fails when a command
# fails, when either block is missing, or when the walk takes longer than WALK_BUDGET_SECS (900, the
# 15 minutes the README is held to).
#
#   .github/selfhost-readme-walk.sh README.md
#   WALK_SOURCE=/path/to/checkout   clone that checkout in place of the README's URL (CI, so a pull
#                                   request walks its own tree)
#   WALK_EXTRACT_ONLY=1             print the script it would run, and stop
set -euo pipefail

readme=$(realpath "${1:?usage: $0 README.md}")
budget=${WALK_BUDGET_SECS:-900}
url=https://github.com/currentai-org/alpha.git

# The shell lines inside the ```sh fence between <!-- name:start --> and <!-- name:end -->.
block() {
	awk -v start="<!-- $1:start -->" -v end="<!-- $1:end -->" '
		$0 == start { on = 1; next }
		$0 == end { on = 0; next }
		on && /^```/ { next }
		on && NF && $1 !~ /^#/ { print }
	' "$readme"
}

walk=$(block readme-walk)
answer=$(block readme-walk-answer)
[ -n "$walk" ] || { echo "FAIL no readme-walk block in $readme" >&2; exit 1; }
[ -n "$answer" ] || { echo "FAIL no readme-walk-answer block in $readme" >&2; exit 1; }
grep -qF "$url" <<<"$walk" || { echo "FAIL the readme-walk block does not clone $url" >&2; exit 1; }
if [ -n "${WALK_SOURCE:-}" ]; then walk=${walk//"$url"/"$WALK_SOURCE"}; fi

# One shell runs every line, so a `cd` carries to the next; each line is timed on its own.
script=$(mktemp)
timings=$(mktemp)
{
	echo 'set -euo pipefail'
	# The \t and \n are for the generated printf, not for this echo.
	# shellcheck disable=SC2028
	echo "__t() { printf '%s\t%s\n' \"\$1\" \"\$2\" >> '$timings'; }"
	while IFS= read -r line; do
		label=$(printf '%q' "$line")
		echo "echo \"+ \"$label; __s=\$(date +%s); $line; __t \$((\$(date +%s) - __s)) $label"
	done <<<"$walk"$'\n'"$answer"
	echo "echo \"\$PWD\" > '$timings.cwd'"
} > "$script"

if [ -n "${WALK_EXTRACT_ONLY:-}" ]; then cat "$script"; exit 0; fi

work=$(mktemp -d)
cleanup() {
	code=$?
	if [ -f "$timings.cwd" ] || [ -d "$work/alpha/selfhost" ]; then
		dir=$(cat "$timings.cwd" 2>/dev/null || echo "$work/alpha/selfhost")
		if [ "$code" != 0 ]; then
			(cd "$dir" && docker compose --profile local ps -a && docker compose --profile local logs --no-color --tail 80) >&2 || true
		fi
		(cd "$dir" && docker compose --profile local down -v) >/dev/null 2>&1 || true
	fi
	exit "$code"
}
trap cleanup EXIT

started=$(date +%s)
(cd "$work" && bash "$script")
total=$(($(date +%s) - started))

{
	echo "### README walk: $total s (budget $budget s)"
	echo
	echo '| seconds | command |'
	echo '| ---: | --- |'
	# The backticks are Markdown, not a command substitution.
	# shellcheck disable=SC2016
	while IFS=$'\t' read -r secs cmd; do printf '| %s | `%s` |\n' "$secs" "$cmd"; done < "$timings"
	echo
	echo "Disk in use after the walk: $(docker system df --format '{{.Type}} {{.Size}}' | paste -sd ' ' -)"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$total" -gt "$budget" ]; then
	echo "FAIL the README walk took $total s, over the $budget s budget" >&2
	exit 1
fi
echo "ok   README walk reached a first answer in $total s"
