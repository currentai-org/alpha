#!/usr/bin/env bash
# Reads soak-stats.sh's JSON lines and reports each container's memory after the first hour, and 100
# minutes before the end, against the soak's last ten minutes, as a table in the step summary and
# soak-verdict.json. A cache that fills and stops (Postgres's buffer pool can take hours) grows a lot
# after the first hour and not at all at the end, so only growth over the final 100 minutes of 2% or
# more is a ::warning::, a climb still going when the soak stops. Growth after the first hour is
# reported beside it. Where the db samples carry soak-stats.sh's breakdown, a second table shows what
# the db's memory was after 1 h and at the end (buffer pool in use against its size, shared and process
# memory, database size), so a filled buffer pool is read from data. The script exits 0.
# Usage: soak-verdict.sh <stats.jsonl>
set -uo pipefail
IN="${1:?usage: soak-verdict.sh <stats.jsonl>}"
OUT="$(dirname "$IN")/soak-verdict.json"
jq -s '
	(map(.t) | min) as $t0 | (map(.t) | max) as $t1
	| def med: sort | if length == 0 then null else .[(length / 2 | floor)] end;
	group_by(.name) | map(
		.[0].name as $n
		| (map(select(.t >= $t0 + 3600 and .t < $t0 + 4200) | .mem_bytes) | med) as $base
		| (map(select(.t >= $t1 - 6000 and .t < $t1 - 5400) | .mem_bytes) | med) as $late
		| (map(select(.t > $t1 - 600) | .mem_bytes) | med) as $end
		| { name: $n, samples: length, minutes: (($t1 - $t0) / 60 | floor),
			mem_after_1h_mib: (if $base then $base / 1048576 | round else null end),
			mem_last_10m_mib: (if $end then $end / 1048576 | round else null end),
			mem_peak_mib: (map(.mem_bytes) | max / 1048576 | round),
			growth_pct: (if $base and $end then (($end / $base - 1) * 1000 | round) / 10 else null end),
			mem_100m_before_end_mib: (if $late and ($t1 - $t0) >= 160 * 60 then $late / 1048576 | round else null end),
			final_100m_growth_pct: (if $late and $end and ($t1 - $t0) >= 160 * 60 then (($end / $late - 1) * 1000 | round) / 10 else null end) }
		+ (map(select(.buffers_bytes != null)) as $b
			| def at($lo; $hi; $f): map(select(.t >= $lo and .t < $hi) | .[$f] // empty) | med | if . then . / 1048576 | round else null end;
			if ($b | length) == 0 then {} else { breakdown: {
				after_1h: { buffers_used_mib: ($b | at($t0 + 3600; $t0 + 4200; "buffers_used_bytes")), shmem_mib: ($b | at($t0 + 3600; $t0 + 4200; "shmem_bytes")),
					anon_mib: ($b | at($t0 + 3600; $t0 + 4200; "anon_bytes")), db_mib: ($b | at($t0 + 3600; $t0 + 4200; "db_bytes")) },
				last_10m: { buffers_used_mib: ($b | at($t1 - 599; $t1 + 1; "buffers_used_bytes")), shmem_mib: ($b | at($t1 - 599; $t1 + 1; "shmem_bytes")),
					anon_mib: ($b | at($t1 - 599; $t1 + 1; "anon_bytes")), db_mib: ($b | at($t1 - 599; $t1 + 1; "db_bytes")) },
				buffers_mib: ($b | map(.buffers_bytes) | max / 1048576 | round) } } end))
' "$IN" > "$OUT"
{
	echo "### Soak memory"
	echo
	echo "| container | minutes | samples | after 1 h | 100 min before end | last 10 min | peak | growth after 1 h | growth over final 100 min |"
	echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
	jq -r 'def pct: if . == null then "n/a" else "\(.)%" end; .[] | "| \(.name) | \(.minutes) | \(.samples) | \(.mem_after_1h_mib // "n/a") MiB | \(.mem_100m_before_end_mib // "n/a") MiB | \(.mem_last_10m_mib // "n/a") MiB | \(.mem_peak_mib) MiB | \(.growth_pct | pct) | \(.final_100m_growth_pct | pct) |"' "$OUT"
	if jq -e 'any(.[]; .breakdown)' "$OUT" > /dev/null; then
		echo
		echo "| container | when | buffer pool in use | shared memory | process memory | database size |"
		echo "| --- | --- | --- | --- | --- | --- |"
		jq -r '.[] | select(.breakdown) | .name as $n | .breakdown as $k | ["after_1h", "last_10m"][] as $w
			| "| \($n) | \(if $w == "after_1h" then "after 1 h" else "last 10 min" end) | \($k[$w].buffers_used_mib // "n/a") of \($k.buffers_mib) MiB | \($k[$w].shmem_mib // "n/a") MiB | \($k[$w].anon_mib // "n/a") MiB | \($k[$w].db_mib // "n/a") MiB |"' "$OUT"
	fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
jq -r '.[] | select(.final_100m_growth_pct == null) | "::warning::\(.name): no final-100-minutes figure, the soak ran \(.minutes) minutes (needs 160)"' "$OUT"
jq -r '.[] | select(.final_100m_growth_pct != null and .final_100m_growth_pct >= 2) | "::warning::\(.name) memory was still climbing: it grew \(.final_100m_growth_pct)% over the final 100 minutes (\(.mem_100m_before_end_mib) to \(.mem_last_10m_mib) MiB)"' "$OUT"
jq -r '.[] | select(.breakdown.last_10m.buffers_used_mib != null and .breakdown.last_10m.buffers_used_mib >= .breakdown.buffers_mib * 0.95) | "\(.name): the buffer pool is full at the end (\(.breakdown.last_10m.buffers_used_mib) of \(.breakdown.buffers_mib) MiB), so memory up to that size is the cache"' "$OUT"
cat "$OUT"
exit 0
