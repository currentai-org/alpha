#!/usr/bin/env bash
# Web search on the self-host stack goes to the self-hoster's own Firecrawl. Run from
# selfhost/ by .github/workflows/selfhost-smoke.yml, and by the public repo's selfhost.yml smoke job
# (scripts/public-snapshot/overlay/.github/workflows/selfhost.yml), once web is recreated with FIRECRAWL_BASE_URL naming
# the `firecrawl` stub (.github/selfhost-firecrawl-stub.compose.yaml) and FIRECRAWL_API_KEY set to the
# stub's key.
#
# A guest sends one turn with web search "always", so the server searches before answering. The stub
# must log a POST /v2/search carrying the turn's question and the configured bearer key. With the
# `rerank` profile up and web given the RERANK_* lines selfhost/README.md lists, the stub's
# page, which no other engine returns, must be among the turn's sources: search cites only what the
# reranker scored as relevant. Exits non-zero on any failure.
set -euo pipefail

BASE="${SMOKE_BASE:-http://localhost:${PORT:-3000}}"
QUESTION="Search the web: where is the Eiffel Tower?"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jar="$tmp/jar"
fail() { echo "WEB-SEARCH FAIL: $*" >&2; exit 1; }

echo "web FIRECRAWL_BASE_URL=$(docker compose --profile local exec -T web node -p "process.env.FIRECRAWL_BASE_URL ?? ''")"

model=$(curl -sf --max-time 20 "$BASE/api/models" | jq -r '.[0].id // .[0].name // empty') || fail "GET /api/models failed"
[ -n "$model" ] || fail "no model advertised"
cid=$(curl -sf --max-time 20 -c "$jar" -b "$jar" -H "origin: $BASE" -H 'content-type: application/json' \
	-d "{\"model\":\"$model\"}" "$BASE/conversation" | jq -r '.conversationId // empty') || fail "POST /conversation failed"
[ -n "$cid" ] || fail "no conversationId"

data=$(jq -cn --arg id "$(cat /proc/sys/kernel/random/uuid)" --arg q "$QUESTION" \
	'{inputs:$q, id:$id, is_retry:false, webSearchMode:"always"}')
curl -sN --max-time "${SMOKE_TURN_TIMEOUT:-300}" -c "$jar" -b "$jar" -H "origin: $BASE" \
	-F "data=$data" "$BASE/conversation/$cid" > "$tmp/turn" || fail "turn request failed (curl exit $?)"
echo "ok   turn finished for conversation $cid ($(wc -c < "$tmp/turn") bytes streamed)"

logs=$(docker compose --profile firecrawl logs --no-color --no-log-prefix firecrawl | grep '^firecrawl-stub request ' || true)
search=$(grep '"path": "/v2/search"' <<<"$logs" | tail -n 1 || true)
[ -n "$search" ] || { head -c 2000 "$tmp/turn" >&2; fail "the Firecrawl stub logged no /v2/search request, so search went elsewhere or never ran"; }
json=${search#firecrawl-stub request }
echo "ok   stub received $(jq -c '{path, bearer, query_chars: ((.query // "") | length)}' <<<"$json")"
[ "$(jq -r .bearer <<<"$json")" = true ] || fail "the search request did not carry FIRECRAWL_API_KEY as its bearer"
jq -e '(.query // "") | test("Eiffel"; "i")' <<<"$json" >/dev/null || fail "the search query does not carry the turn's question"
echo "ok   $(grep -c . <<<"$logs") stub request(s) in all, $(grep -c '"path": "/v2/scrape"' <<<"$logs" || true) scrape"

retrieval=$(docker compose --profile local logs --no-color --no-log-prefix web 2>&1 | grep '\[retrieval\] timing' | tail -n 1 || true)
[ -n "$retrieval" ] && echo "note retrieval $(jq -c '{groundedWeb, sources, webMs}' <<<"$retrieval" 2>/dev/null || echo unparsed)"
grep -q 'selfhost-search-stub-page' "$tmp/turn" \
	|| fail "the stub's page is not among the turn's sources, so the reranker did not vouch for it (is the rerank profile up and RERANK_* set on web?)"
echo "ok   the stub's page is among the turn's sources"

# The CPU cost of a full batch, which a turn against the stub never reaches: one /rerank call from web
# at the hosted net's size, and one at compose's RERANK_MAX_DOCS x RERANK_DOC_CHARS, which must finish
# inside RERANK_TIMEOUT_MS (README.md, "Web search with sources", states both figures).
time_rerank() { # count chars
	local doc body
	doc=$(printf 'The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris. %.0s' $(seq 1 15) | cut -c1-"$2")
	body=$(jq -cn --arg q "where is the Eiffel Tower" --arg d "$doc" --argjson n "$1" '{query:$q, texts:[range($n) | $d], raw_scores:false}')
	docker compose --profile local exec -T web node -e '
const t = Date.now();
fetch("http://rerank:8080/rerank", { method: "POST", headers: { "content-type": "application/json" }, body: process.argv[1] })
  .then((r) => r.json())
  .then((j) => console.log(Array.isArray(j) && j.length === Number(process.argv[2]) ? String(Date.now() - t) : "bad-response"))
  .catch(() => console.log("error"));
' "$body" "$1" || echo error
}
echo "note rerank of 32 documents x 1200 characters (the hosted net) took $(time_rerank 32 1200) ms"
# compose.yaml's defaults for the bundled reranker must fit the deadline it sets, on this runner.
read -r docs chars deadline < <(docker compose --profile local exec -T web node -p \
	'[process.env.RERANK_MAX_DOCS, process.env.RERANK_DOC_CHARS, process.env.RERANK_TIMEOUT_MS].join(" ")')
ms=$(time_rerank "$docs" "$chars")
echo "note rerank of $docs documents x $chars characters (compose's defaults) took $ms ms, deadline $deadline"
[[ "$ms" =~ ^[0-9]+$ ]] || fail "the timed rerank call failed: $ms"
[ "$ms" -lt "$deadline" ] || fail "compose's rerank defaults ($docs x $chars) took $ms ms, over RERANK_TIMEOUT_MS=$deadline"
echo "ok   compose's rerank defaults fit the deadline"
echo "WEB-SEARCH PASS"
