#!/usr/bin/env bash
# An editor's CMS publish shows on a running Alpha web container with no restart and no redeploy.
# The container is the adapter-node image, so no Vercel cache and no CDN sits in front:
# the server's own in-memory CMS cache is the only copy between the publish and the next visitor.
#
#   CMS_STUB=http://127.0.0.1:18081 CMS_REVALIDATE_SECRET=... SMOKE_BASE=http://localhost:3100 \
#     deploy/cms-publish-smoke.sh
#
# The CMS is e2e/local/upstream-stub.mjs, whose one published page (/cms-publish-check) changes title on
# `POST /__stub/cms-page`. The steps:
#
#   1. the page renders with title A;
#   2. the CMS changes the page to title B, and the page still renders A (the cache is in the path; a
#      check that saw B here would pass with the publish route doing nothing, so this fails it);
#   3. the publish webhook the CMS calls in production (`POST /api/cms/invalidate`) lands with 200;
#   4. the next render is title B.
#
# The cache keeps a CMS page for a minute (PAGE_TTL in cached-client.ts), so steps 2 to 4 must finish
# well inside that, or the TTL could explain step 4. With SMOKE_CONTAINER set, the container's start
# time is read before and after, and a restart fails the check. Exits non-zero on any failure. Needs
# curl and jq. .github/workflows/web-image.yml runs it against the image it just built.
set -euo pipefail

BASE="${SMOKE_BASE:-http://localhost:${PORT:-3000}}"
STUB="${CMS_STUB:?CMS_STUB, the upstream stub serving the CMS reads, is required}"
: "${CMS_REVALIDATE_SECRET:?CMS_REVALIDATE_SECRET, the value the container was started with, is required}"
PAGE=/cms-publish-check
PUBLISH_ROUTE=/api/cms/invalidate
MAX_WINDOW_S="${CMS_SMOKE_MAX_WINDOW_S:-40}"
nonce=$(date +%s)-$RANDOM
title_a="Before the publish $nonce"
title_b="After the publish $nonce"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "CMS PUBLISH FAIL: $*" >&2; exit 1; }

set_cms_title() {
	curl -sf --max-time 10 -H 'content-type: application/json' \
		-d "$(jq -cn --arg t "$1" '{title:$t}')" "$STUB/__stub/cms-page" > /dev/null \
		|| fail "the CMS stub at $STUB would not take a new title"
}
render() {
	local code
	code=$(curl -s -o "$tmp/page.html" -w '%{http_code}' --max-time 30 "$BASE$PAGE" || true)
	[ "$code" = 200 ] || { head -c 1000 "$tmp/page.html" >&2 || true; fail "GET $PAGE returned $code"; }
}
shows() { grep -qF -- "$1" "$tmp/page.html"; }
started_at() { docker inspect --format '{{.State.StartedAt}} restarts={{.RestartCount}}' "$SMOKE_CONTAINER"; }

[ -z "${SMOKE_CONTAINER:-}" ] || before_start=$(started_at)

# 1. The page as first published.
set_cms_title "$title_a"
render
shows "$title_a" || fail "$PAGE does not show the CMS's title \"$title_a\""
echo "ok   $PAGE renders \"$title_a\" from the CMS"

# 2. The editor changes the page in the CMS. Until the publish webhook lands, the server's cache holds A.
window_start=$(date +%s)
set_cms_title "$title_b"
render
shows "$title_b" && fail "$PAGE showed \"$title_b\" before any publish reached the server: no cache in the path, so this check cannot tell a working publish from a broken one"
shows "$title_a" || fail "$PAGE shows neither title before the publish"
echo "ok   before the publish, $PAGE still renders the cached \"$title_a\""

# 3. The publish webhook, as payload/src/hooks/notifyWebCache.ts sends it for a published page.
body=$(jq -cn --arg url "$PAGE" '{collection:"pages", doc:{breadcrumbs:[{url:$url}], _status:"published"}}')
printf 'x-cms-revalidate-secret: %s\n' "$CMS_REVALIDATE_SECRET" > "$tmp/headers"
code=$(curl -s -o "$tmp/publish" -w '%{http_code}' --max-time 30 -H 'content-type: application/json' \
	-H "@$tmp/headers" -d "$body" "$BASE$PUBLISH_ROUTE" || true)
[ "$code" = 200 ] || { head -c 500 "$tmp/publish" >&2 || true; fail "POST $PUBLISH_ROUTE returned $code"; }
echo "ok   POST $PUBLISH_ROUTE 200: $(head -c 300 "$tmp/publish")"

# 4. The next render is the published change.
render
window=$(($(date +%s) - window_start))
shows "$title_b" || fail "after the publish, $PAGE does not show \"$title_b\" (still shows \"$title_a\": $(shows "$title_a" && echo yes || echo no))"
[ "$window" -lt "$MAX_WINDOW_S" ] || fail "the change showed, but ${window}s after the CMS edit, close enough to the cache's one-minute TTL that the TTL could explain it"
echo "ok   after the publish, $PAGE renders \"$title_b\", ${window}s after the CMS edit"

if [ -n "${SMOKE_CONTAINER:-}" ]; then
	after_start=$(started_at)
	[ "$before_start" = "$after_start" ] || fail "the container restarted during the check ($before_start -> $after_start)"
	echo "ok   no restart: container $SMOKE_CONTAINER started $after_start throughout"
fi
echo "CMS PUBLISH OK: an editor's publish showed on the running container with no restart or redeploy"
