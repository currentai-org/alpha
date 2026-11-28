#!/usr/bin/env bash
# Snapshots a database before a deploy migrates it, migrates it, and restores it from the snapshot by hand.
# Used by deploy.yml (both jobs) and db-restore.yml.
#
#   neon-snapshot.sh needed <ref> [<prev>]  prints true when <ref> adds a migration since <prev>. Without
#                                           <prev>, since the release before <ref> (a tag's predecessor)
#   neon-snapshot.sh snapshot <name>        creates branch pre-<name> from NEON_BRANCH_ID, now; prints its id
#   neon-snapshot.sh url                    prints NEON_BRANCH_ID's direct (unpooled) connection URI, for
#                                           migrations. It carries the password: mask it before anything logs
#   neon-snapshot.sh restore <name>         restores NEON_BRANCH_ID from pre-<name>, keeping its state as
#                                           rolled-back-<name>-<run id> so writes made since can be recovered
#   neon-snapshot.sh prune                  deletes all but the newest three pre-* branches
#
# Env: NEON_API_KEY (a Neon API key limited to this database's project), NEON_PROJECT_ID, NEON_BRANCH_ID (the
# branch the deployment serves), and for url NEON_DATABASE and NEON_ROLE (default neondb and neondb_owner).
# A snapshot is a Neon child branch: copy-on-write, so it costs storage only for what changes after.
set -euo pipefail

API=${NEON_API_URL:-https://console.neon.tech/api/v2} # overridable only so the tests can point it at a stub
JOURNAL=web/drizzle/meta/_journal.json

neon() { # method path [json body]
	local args=(-sS --fail-with-body -X "$1" -H "Authorization: Bearer $NEON_API_KEY" -H "Accept: application/json")
	if [ $# -ge 3 ]; then args+=(-H "Content-Type: application/json" --data "$3"); fi
	curl "${args[@]}" "$API/projects/$NEON_PROJECT_ID$2"
}

# Waits for every operation a call started, so the next call never races a branch still being made.
wait_ops() { # response json on stdin
	local ids id status
	ids=$(jq -r '.operations[]?.id')
	for id in $ids; do
		for _ in $(seq 1 60); do
			status=$(neon GET "/operations/$id" | jq -r .operation.status)
			case "$status" in
			finished | skipped) break ;;
			failed | error | cancelled)
				echo "::error title=neon::operation $id ended $status" >&2
				exit 1
				;;
			esac
			sleep 5
		done
		if [ "$status" != finished ] && [ "$status" != skipped ]; then
			echo "::error title=neon::operation $id still $status after five minutes" >&2
			exit 1
		fi
	done
}

branch_id() { # name -> id, or empty
	neon GET "/branches?search=$1" | jq -r --arg n "$1" '.branches[] | select(.name == $n) | .id' | head -n 1
}

case "${1:-}" in
needed)
	tag=${2:?ref}
	prev=${3:-}
	if [ -z "$prev" ]; then
		# The release before this one is the newest earlier tag that deploys production, so a tag that only
		# publishes an image (vX.Y.Z-beta) never hides a migration the database has not had.
		prev=$(git tag --merged "$tag^" --sort=-creatordate 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-(preview|rc)\.[0-9]+)?$' | head -n 1 || true)
	fi
	if [ -z "$prev" ] || ! git cat-file -e "$prev:$JOURNAL" 2>/dev/null; then
		echo true # nothing before this one to compare with, so snapshot to be safe
		exit 0
	fi
	count() { git show "$1:$JOURNAL" | jq '.entries | length'; }
	if [ "$(count "$tag")" -gt "$(count "$prev")" ]; then echo true; else echo false; fi
	;;
snapshot)
	tag=${2:?name}
	name="pre-$tag"
	existing=$(branch_id "$name")
	if [ -n "$existing" ]; then
		echo "$existing" # a rerun of the same release keeps the first snapshot, taken before any migration ran
		exit 0
	fi
	body=$(jq -nc --arg p "$NEON_BRANCH_ID" --arg n "$name" '{branch: {parent_id: $p, name: $n}}')
	resp=$(neon POST /branches "$body")
	wait_ops <<<"$resp"
	jq -r .branch.id <<<"$resp"
	;;
url)
	neon GET "/connection_uri?branch_id=$NEON_BRANCH_ID&database_name=${NEON_DATABASE:-neondb}&role_name=${NEON_ROLE:-neondb_owner}&pooled=false" | jq -er .uri
	;;
restore)
	tag=${2:?name}
	source=$(branch_id "pre-$tag")
	if [ -z "$source" ]; then
		echo "::error title=neon::no branch pre-$tag to restore from" >&2
		exit 1
	fi
	keep="rolled-back-$tag-${GITHUB_RUN_ID:-manual}"
	body=$(jq -nc --arg s "$source" --arg k "$keep" '{source_branch_id: $s, preserve_under_name: $k}')
	neon POST "/branches/$NEON_BRANCH_ID/restore" "$body" | wait_ops
	echo "branch $NEON_BRANCH_ID restored from pre-$tag; its state before the restore is branch $keep"
	;;
prune)
	neon GET "/branches?limit=10000" |
		jq -r '[.branches[] | select(.name | startswith("pre-"))] | sort_by(.created_at) | reverse | .[3:][] | "\(.id) \(.name)"' |
		while read -r id name; do
			neon DELETE "/branches/$id" >/dev/null
			echo "deleted snapshot $name"
		done
	;;
*)
	echo "usage: $0 needed <ref> [<prev>] | snapshot|restore <name> | url | prune" >&2
	exit 2
	;;
esac
