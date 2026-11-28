#!/usr/bin/env bash
# Samples CPU about every 6 s until killed, so a level's bend can be laid against what was busy. One JSON
# line per sample:
#   {"t":<unix s>,"runner_busy_pct":..,"load1":..,"nproc":..,"cpu":{"web":..,"db":..,"k6":..,"aimock":..}}
# - cpu: each running container's `docker stats` CPU%, where 100 is one whole core. The single Node
#   process in web cannot run JavaScript on more than one core, so web near 100 means its event loop is full.
#   With several web processes, web is their sum and web_1, web_2... are each one.
# - runner_busy_pct: the share of all the runner's CPUs that was busy since the last sample (/proc/stat),
#   where 100 means every core. k6 runs on the same runner, so this is the whole box.
# Started by run-levels.sh beside each level's k6 run (`cpu-sample.sh <out.jsonl>`), whose container it
# names k6-<label>.
set -uo pipefail
OUT="${1:?usage: cpu-sample.sh <out.jsonl>}"
NPROC=$(nproc)
read_stat() { awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; printf "%d %d\n", total, idle }' /proc/stat; }
read -r T0 I0 < <(read_stat)
while :; do
	CPU=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null |
		awk '{ n = $1; c = $2; sub(/%$/, "", c); c += 0
			# Every web process adds into "web"; with more than one (compose.two-web.yaml), each also has web_<n>.
			if (n ~ /-web-[0-9]+$/) { r = n; sub(/.*-web-/, "", r); web += c; per["web_" r] = c; nweb++; next }
			if (n ~ /^k6-/) s = "k6"; else if (n ~ /-db-[0-9]+$/) s = "db"; else if (n ~ /aimock/) s = "aimock"; else s = n
			printf "%s\"%s\":%s", (i++ ? "," : ""), s, c }
			END { if (nweb) printf "%s\"web\":%s", (i++ ? "," : ""), web
				if (nweb > 1) for (k in per) printf ",\"%s\":%s", k, per[k] }')
	read -r T1 I1 < <(read_stat)
	BUSY=$(awk -v t=$((T1 - T0)) -v i=$((I1 - I0)) 'BEGIN { printf "%.1f", (t > 0 ? 100 * (t - i) / t : 0) }')
	T0=$T1
	I0=$I1
	printf '{"t":%s,"runner_busy_pct":%s,"load1":%s,"nproc":%s,"cpu":{%s}}\n' \
		"$(date +%s)" "$BUSY" "$(cut -d' ' -f1 /proc/loadavg)" "$NPROC" "$CPU" >> "$OUT"
	sleep 4
done
