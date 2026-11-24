#!/usr/bin/env bash
# Release the agent service and its gateway to the AWS hosts this directory's Terraform built (README.md).
#
#   AWS_PROFILE=<account profile> DOPPLER_CONFIG=<config> ./deploy.sh                    # source, env, gateway, agent
#   AWS_PROFILE=<account profile> DOPPLER_CONFIG=<config> STACK=production ./deploy.sh
#   ./deploy.sh --check-source                                 # runs the source check and touches nothing else
#   ./deploy.sh --check-archive [rev]                          # builds and checks the source archive of rev (default
#                                                              # HEAD); needs no AWS, Doppler or Terraform
#   AWS_PROFILE=<account profile> ./deploy.sh --rollback      # both hosts back to their previous release
#
# Source: the agent-service/ tree at the stack's branch tip, or at AGENT_DEPLOY_REF when set (a branch, a tag or a commit), uploaded as a tarball and built on each host. Env: the tracked Fly toml's [env], the role's Doppler keys (agent.keys,
# gateway.keys) and this stack's addresses, rendered by render_env.py into one SecureString parameter per role.
# Rendered values touch disk only in a 0700 temporary directory, deleted as each parameter is written and again on
# exit. agent-service-deploy.yml runs this from CI.
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK:-develop}"
TF="${TF:-terraform}"
# Without AGENT_DEPLOY_REF, a stack deploys its branch tip: develop for a test stack, main for production. A deploy of
# a release names its tag in AGENT_DEPLOY_REF.
case "$STACK" in
  develop) BRANCH=develop ;;
  production) BRANCH=main ;;
  *) echo "STACK is develop or production" >&2; exit 2 ;;
esac
DOPPLER_CONFIG="${DOPPLER_CONFIG:-}"   # the Doppler config holding this stack's keys; required to deploy
# What to deploy: the stack's branch by default. A repository without that branch layout, or a deploy pinned to a tag
# or to the commit an earlier stage verified, names it here.
REF="${AGENT_DEPLOY_REF:-$BRANCH}"

# Sets SRC to the commit REF names: a branch as the remote holds it now (origin/<branch>, freshly fetched), otherwise
# the tag or commit this run fetched. A branch moves, so a failed fetch refuses rather than deploy a stale
# origin/<branch>. A tag or commit never moves, so one already here (a pinned commit a shallow CI checkout holds but
# cannot fetch by name) is used when the fetch fails.
resolve_source() {
  if git fetch -q origin "$REF"; then
    SRC=$(git rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" ||
          git rev-parse -q --verify "FETCH_HEAD^{commit}") ||
      { echo "fetched $REF but could not resolve it to a commit" >&2; return 1; }
  elif git rev-parse -q --verify "refs/remotes/origin/$REF" > /dev/null || [ "$REF" = "$BRANCH" ]; then
    echo "could not fetch branch $REF, and its local copy may be stale; refusing to deploy it" >&2
    return 1
  else
    SRC=$(git rev-parse -q --verify "$REF^{commit}") ||
      { echo "could not fetch $REF, and it is not a tag or commit here" >&2; return 1; }
  fi
}

# Deploy only what the stack's branch tip (or the named ref) holds, the rule ci-runners/deploy.sh enforces: a release
# from an unmerged branch serves code nobody reviewed, and one from a stale checkout rolls back whatever merged since.
# The tarball comes from that commit itself; this check makes sure the Terraform outputs, keys files and render step
# running here are that commit's too. AGENT_AWS_DEPLOY_UNMERGED=<reason> is the break-glass, and its change still has
# to reach the deployed branch.
check_source() {
  resolve_source || return 1
  local problem=""
  if [ -n "$(git status --porcelain -- ../../..)" ]; then
    problem="agent-service/ has uncommitted or untracked changes"
  elif git diff --quiet "$SRC" -- ../../..; then
    echo "source ok: agent-service/ matches $REF ($SRC)"
    return 0
  else
    problem="agent-service/ differs from $REF (behind it, or unmerged)"
  fi
  if [ -n "${AGENT_AWS_DEPLOY_UNMERGED:-}" ]; then
    echo "WARNING: deploying anyway ($problem): $AGENT_AWS_DEPLOY_UNMERGED" >&2
    return 0
  fi
  echo "refusing to deploy: $problem. Merge your change into $REF and deploy from it." >&2
  return 1
}
# Builds the tarball of rev's agent-service/ tree at dest and checks that it holds the Dockerfile the hosts build
# from. The deploy and --check-archive both run this.
build_source_archive() {  # build_source_archive REV DEST
  local rev=$1 dest=$2
  # git archive keeps only the current directory's part of a tree, so it runs from the repository root.
  git -C "$(git rev-parse --show-toplevel)" archive --format=tar.gz "$rev:agent-service" > "$dest"
  # The listing goes to a file first: grep -q exits at its first match, and under pipefail tar's SIGPIPE would
  # fail the check on an archive that does hold the file.
  tar -tzf "$dest" > "$dest.list"
  grep -qx 'deploy/Dockerfile' "$dest.list" ||
    { echo "the source archive has no deploy/Dockerfile; refusing to upload it" >&2; return 1; }
}

if [ "${1:-}" = "--check-archive" ]; then
  rev="${2:-HEAD}"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  build_source_archive "$rev" "$work/src.tar.gz"
  echo "archive ok: $rev:agent-service is $(wc -c < "$work/src.tar.gz") bytes, $(wc -l < "$work/src.tar.gz.list") entries, with deploy/Dockerfile"
  exit 0
fi

check_source || exit 1
[ "${1:-}" = "--check-source" ] && exit 0

# A profile by hand; in CI, the keys configure-aws-credentials exported for the deploy role (agent-service-deploy.yml).
[ -n "${AWS_PROFILE:-}${AWS_ACCESS_KEY_ID:-}" ] ||
  { echo "set AWS_PROFILE to the account's profile; there is no default account" >&2; exit 2; }

want_ws=$([ "$STACK" = develop ] && echo default || echo "$STACK")
[ "$("$TF" workspace show)" = "$want_ws" ] || { echo "select workspace $want_ws for stack $STACK first" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$TF" output -json deploy > "$work/deploy.json"
out() {  # out KEY [SUBKEY]: one value from terraform's deploy output
  python3 -c 'import json, sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2:]:
    v = v[k]
print(v)' "$work/deploy.json" "$@"
}
REGION=$(out region)
[ "$(out stack)" = "$STACK" ] || { echo "terraform state is for stack $(out stack), not $STACK" >&2; exit 2; }

# Runs potluck-release on one host over SSM and waits for it. Prints the host's own output, which names the
# release and, on failure, the container's log tail and whether it rolled back.
release() {
  local role=$1 arg=$2 id cmd status
  id=$(out instance_id "$role")
  cmd=$(aws ssm send-command --region "$REGION" --instance-ids "$id" --document-name AWS-RunShellScript \
    --comment "potluck-release $role $arg" --timeout-seconds 1800 \
    --parameters "commands=[\"/usr/local/sbin/potluck-release $arg\"],executionTimeout=[\"1800\"]" \
    --query Command.CommandId --output text)
  echo "== $role ($id): potluck-release $arg"
  while :; do
    sleep 10
    status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd" --instance-id "$id" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in Pending|InProgress|Delayed) continue ;; esac
    break
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd" --instance-id "$id" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -n 60
  [ "$status" = Success ] || { echo "== $role: $status" >&2; return 1; }
}

if [ "${1:-}" = "--rollback" ]; then
  release agent --previous
  release gateway --previous
  exit 0
fi

SHA=$SRC
[ -n "$DOPPLER_CONFIG" ] || { echo "set DOPPLER_CONFIG to the Doppler config holding this stack's keys" >&2; exit 2; }
echo "deploying $SHA to stack $STACK in $REGION (account $(aws sts get-caller-identity --query Account --output text)), env from Doppler agent-service/$DOPPLER_CONFIG"

build_source_archive "$SHA" "$work/src.tar.gz" || exit 1
aws s3 cp --region "$REGION" --quiet "$work/src.tar.gz" "s3://$(out bucket)/src/$SHA.tar.gz"

# Env first: each host reads it when the new release first starts and keeps it with that release, so a rollback to
# the previous release runs with that release's own env. Advanced tier: the agent's env passes the standard 4 KB.
for role in gateway agent; do
  doppler secrets download --project agent-service --config "$DOPPLER_CONFIG" --no-file --format json |
    python3 render_env.py --role "$role" --deploy "$work/deploy.json" > "$work/$role.env"
  [ "$(wc -c < "$work/$role.env")" -lt 8192 ] || { echo "$role env is over 8 KB, the parameter limit" >&2; exit 1; }
  aws ssm put-parameter --region "$REGION" --name "$(out env_param "$role")" --type SecureString --tier Advanced \
    --overwrite --value "file://$work/$role.env" >/dev/null
  rm -f "$work/$role.env"
  echo "== $role env written ($(out env_param "$role"))"
done

# From here on a host may change. In Actions, say so as a step output, so a failure alert can tell a deploy that
# stopped before any host (Doppler, state, credentials) from one that released.
[ -z "${GITHUB_OUTPUT:-}" ] || echo "released=true" >> "$GITHUB_OUTPUT"

# The gateway first: the agent refuses to boot without its gateway (AGENT_MODEL_PROXY_REQUIRED).
release gateway "$SHA"
release agent "$SHA"

# The same check the Fly workflow makes: the public name serves the build just released. Before DNS points here,
# --connect-to sends the request to the load balancer while TLS still checks the real name.
host=$(out agent_url); host=${host#https://}
body=$(curl -sf --max-time 10 --connect-to "$host:443:$(out alb_dns_name):443" "https://$host/healthz")
case "$body" in *"${SHA:0:7}"*) echo "== $host/healthz serves ${SHA:0:7}" ;;
  *) echo "== $host/healthz does not name ${SHA:0:7}; the load balancer may still be registering the target" >&2; exit 1 ;;
esac
