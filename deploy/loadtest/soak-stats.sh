#!/usr/bin/env bash
# Samples `docker stats` for the compose stack's web and db containers once a minute until killed,
# one JSON line per container per sample: {"t":<unix s>,"name":..,"mem_bytes":..,"cpu_pct":..}.
# The db line also carries what that memory is: the cgroup's shared memory (`shmem`, where Postgres's
# buffer pool lives) and process memory (`anon`), the bytes of buffer pool in use and its size
# (pg_buffercache, created on first sample), and the database's size on disk. A buffer pool filling to
# its size reads as growth in mem_bytes and stops there; a leak shows in anon and keeps going.
# Started by .github/workflows/load.yml beside the soak's k6 run, from deploy/ with COMPOSE_FILE set
# (`soak-stats.sh <out.jsonl>`).
set -uo pipefail
OUT="${1:?usage: soak-stats.sh <out.jsonl>}"
to_bytes() { # "123.4MiB" -> bytes
	awk -v v="$1" 'BEGIN { n = v + 0; u = v; sub(/^[0-9.]+/, "", u);
		m = (u == "KiB") ? 1024 : (u == "MiB") ? 1048576 : (u == "GiB") ? 1073741824 : (u == "kB") ? 1000 : (u == "MB") ? 1e6 : (u == "GB") ? 1e9 : 1;
		printf "%d", n * m }'
}
# ,"shmem_bytes":..,"anon_bytes":..,"buffers_used_bytes":..,"buffers_bytes":..,"db_bytes":.. for the db
# container; a field it could not read is left out, so a sample is never lost to the breakdown.
db_breakdown() {
	local id=$1 stat sql
	stat=$(docker exec "$id" cat /sys/fs/cgroup/memory.stat 2>/dev/null |
		awk '$1 == "shmem" || $1 == "anon" { printf ",\"%s_bytes\":%s", $1, $2 }')
	sql=$(docker exec "$id" psql -U alpha -d alpha -tAq -c "CREATE EXTENSION IF NOT EXISTS pg_buffercache" \
		-c "SELECT ',\"buffers_used_bytes\":' || count(relfilenode) * current_setting('block_size')::int
			|| ',\"buffers_bytes\":' || count(*) * current_setting('block_size')::int
			|| ',\"db_bytes\":' || pg_database_size(current_database()) FROM pg_buffercache" 2>/dev/null | tr -d '\n')
	printf '%s%s' "$stat" "$sql"
}
while :; do
	T=$(date +%s)
	for svc in web db; do
		ID=$(docker compose ps -q "$svc" 2>/dev/null | head -n 1)
		[ -n "$ID" ] || continue
		LINE=$(docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' "$ID" 2>/dev/null) || continue
		MEM=$(to_bytes "${LINE%% / *}")
		CPU="${LINE##*|}"
		EXTRA=""
		[ "$svc" = db ] && EXTRA=$(db_breakdown "$ID")
		printf '{"t":%s,"name":"%s","mem_bytes":%s,"cpu_pct":%s%s}\n' "$T" "$svc" "$MEM" "${CPU%\%}" "$EXTRA" >> "$OUT"
	done
	sleep 60
done
