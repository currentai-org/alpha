#!/usr/bin/env bash
# k6-chat.js at each of $LEVELS virtual users, one after the other, with the database's connections
# sampled every 5 s while each level runs. Called by .github/workflows/load.yml from the repository root
# as `run-levels.sh <pass>`, once per PG_POOL_MAX setting.
#
# Needs DATABASE_URL (the stack's database on loopback), K6_IMAGE, LEVELS, HOLD and THINK_SECS. Writes
# loadtest-out/<pass>/<level>.json (k6's row), <level>-full.json (k6's whole summary), <level>-db.json (the
# database's peak connections and size), <level>-cpu.jsonl (cpu-sample.sh's samples) and <level>-cpu.json
# (their mean and peak over the hold), and appends two tables to the step summary: the turns, then CPU.
#
# Warn-only: a level k6 cannot finish is a ::warning::, and the script exits 0.
set -uo pipefail

PASS="${1:?usage: run-levels.sh <pass>}"
OUT="loadtest-out/$PASS"
mkdir -p "$OUT"
chmod 777 "$OUT" # the k6 image runs as a non-root user

db() { psql "$DATABASE_URL" -tAq -c "$1" 2>/dev/null; }
CPU_TABLE="$OUT/cpu-table.md"
{
	echo "| VUs | web CPU mean / peak | db CPU mean / peak | k6 CPU mean / peak | runner busy mean / peak | load1 peak |"
	echo "| --- | --- | --- | --- | --- | --- |"
} > "$CPU_TABLE"

{
	echo "### $PASS"
	echo
	echo "| VUs | turns/min | turn p50 | turn p95 | first byte p95 | create p95 | errors | declined | 429 | 5xx | peak DB connections |"
	echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

for VUS in $LEVELS; do
	LABEL="${PASS}-${VUS}vu"
	echo "== $LABEL"

	# Peak connections while the level runs. Every connection but the sampler's own is the app's.
	PEAK_FILE="$OUT/$LABEL.peak"
	echo 0 > "$PEAK_FILE"
	(
		while :; do
			N=$(db "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()") || N=""
			if [ -n "$N" ] && [ "$N" -gt "$(cat "$PEAK_FILE")" ]; then echo "$N" > "$PEAK_FILE"; fi
			sleep 5
		done
	) &
	SAMPLER=$!
	bash "$(dirname "$0")/cpu-sample.sh" "$OUT/$LABEL-cpu.jsonl" &
	CPU_SAMPLER=$!
	START=$(date +%s)

	docker run --rm --network host --name "k6-$LABEL" \
		-e VUS="$VUS" -e HOLD="$HOLD" -e THINK_SECS="$THINK_SECS" -e LABEL="$LABEL" \
		-v "$PWD/deploy/loadtest:/scripts:ro" -v "$PWD/$OUT:/out" \
		"$K6_IMAGE" run --quiet /scripts/k6-chat.js
	CODE=$?
	END=$(date +%s)
	kill "$SAMPLER" "$CPU_SAMPLER" 2>/dev/null
	wait "$SAMPLER" "$CPU_SAMPLER" 2>/dev/null
	# Hold only: past k6's 20 s ramp, and short of its 30 s graceful ramp-down.
	jq -s --arg label "$LABEL" --argjson from "$((START + 25))" --argjson to "$((END - 30))" '
		[.[] | select(.t >= $from and .t <= $to)] as $s
		| def st(f): [$s[] | f | numbers] as $v
			| if ($v | length) == 0 then null else {mean: (($v | add) / ($v | length) * 10 | round / 10), peak: ($v | max)} end;
		{label: $label, samples: ($s | length), nproc: $s[0].nproc, web: st(.cpu.web), web_1: st(.cpu.web_1), web_2: st(.cpu.web_2), db: st(.cpu.db), k6: st(.cpu.k6),
			aimock: st(.cpu.aimock), runner_busy: st(.runner_busy_pct), load1: st(.load1)}' \
		"$OUT/$LABEL-cpu.jsonl" > "$OUT/$LABEL-cpu.json" 2>/dev/null || echo "{\"label\":\"$LABEL\"}" > "$OUT/$LABEL-cpu.json"
	jq -r --arg vus "$VUS" 'def mp(x): if x == null then "n/a" else "\(x.mean)% / \(x.peak)%" end;
		"| \($vus) | \(mp(.web)) | \(mp(.db)) | \(mp(.k6)) | \(mp(.runner_busy)) of \(.nproc // "?") CPUs | \(.load1.peak // "n/a") |"' \
		"$OUT/$LABEL-cpu.json" >> "$CPU_TABLE"
	[ "$CODE" = 0 ] || echo "::warning::k6 exited $CODE at $LABEL"

	PEAK=$(cat "$PEAK_FILE")
	SIZE=$(db "select pg_database_size(current_database())") || SIZE=""
	printf '{"label":"%s","peak_connections":%s,"database_bytes":%s}\n' "$LABEL" "${PEAK:-null}" "${SIZE:-null}" > "$OUT/$LABEL-db.json"

	if [ -f "$OUT/$LABEL.json" ]; then
		# A level with no answered turns measured an error path, not chat: say so where it is read.
		if jq -e '.turns_hold == 0 or (.error_rate // 1) >= 0.5' "$OUT/$LABEL.json" >/dev/null; then
			echo "::warning::$LABEL is not evidence: $(jq -r '"\(.turns_hold) hold turns, error rate \(.error_rate)"' "$OUT/$LABEL.json"). Read k6's own errors above."
		fi
		jq -r --argjson peak "${PEAK:-0}" \
			'"| \(.vus) | \(.turns_per_min) | \(.turn_p50_ms) ms | \(.turn_p95_ms) ms | \(.ttfb_p95_ms) ms | \(.create_p95_ms) ms | \(if .error_rate == null then "n/a" else ((.error_rate * 10000 | round) / 100 | tostring) + "%" end) | \(.turn_declined // "n/a") | \(.turn_429) | \(.turn_5xx) | \($peak) |"' \
			"$OUT/$LABEL.json" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
	else
		echo "| $VUS | k6 wrote no summary (exit $CODE) | | | | | | | | | $PEAK |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
	fi
done

SIZE=$(db "select pg_size_pretty(pg_database_size(current_database()))") || SIZE="unread"
{
	echo
	echo "CPU over each hold. A container's 100% is one core; the runner's 100% is every core, k6's included. With several web processes, web is their sum ($PASS-<level>-cpu.json has each)."
	echo
	cat "$CPU_TABLE"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "Database size after the $PASS pass: $SIZE" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
