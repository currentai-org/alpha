#!/usr/bin/env bash
# Build the sandbox template on the E2B host itself (CUR-4482), over SSM, so nothing runs on a laptop and the
# team API key never leaves the host. Usage: [E2B_TEMPLATE_ALIAS=hermes] build-on-host.sh <instance-id> [aws profile]
# An empty profile ('') uses the ambient credentials, as agent-service-deploy.yml's template job does after
# assuming its OIDC role (CUR-4573).
set -euo pipefail
instance=$1 profile=${2-potluck-sandbox}
aws_() { if [ -n "$profile" ]; then aws --profile "$profile" "$@"; else aws "$@"; fi; }
here=$(cd "$(dirname "$0")" && pwd)
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
# The whole template directory, so a file the Dockerfile COPYs (guest-libraries.txt) can't be left behind: a COPY
# source missing from the build context fails build.mjs before any step runs.
cp -r "$here"/. "$ctx/"
cp -r "$here/../hermes" "$ctx/hermes"
bundle=$(tar -C "$ctx" -czf - . | base64 -w0)
# The node-e2b image and the key file are Embed's own (compose.yaml, base-template service).
script=$(cat <<SH
set -e
d=\$(mktemp -d); echo "$bundle" | base64 -d | tar -C "\$d" -xzf -
cd /opt/e2b; img=\$(grep '^E2B_NODE_E2B_IMAGE=' .env | cut -d= -f2 | cut -d' ' -f1)
# A build VM and each sandbox get the tier's free disk, 512 MB by default: too small for Python and Hermes'
# dependencies and the guest library list. 12 GB, what production runs, under the tier's own 25,600 MB cap. Idempotent.
pg=\$(docker compose ps -q postgres)
docker exec "\$pg" sh -c 'psql -q -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-postgres}" -c "update tiers set disk_mb = greatest(disk_mb, ${FREE_DISK_MB:-12288}), default_free_disk_size_mb = greatest(default_free_disk_size_mb, ${FREE_DISK_MB:-12288})"'
key=\$(docker run --rm -v e2b_seed-state:/run/e2b --entrypoint cat "\$img" /run/e2b/team-api-key)
docker run --rm --network host -v "\$d":/build -w /app -e E2B_API_URL=http://127.0.0.1:3000 -e E2B_SANDBOX_URL=http://127.0.0.1:3002 -e E2B_API_KEY="\$key" \
  -e E2B_TEMPLATE_ALIAS="${E2B_TEMPLATE_ALIAS:-hermes}" \
  --entrypoint sh "\$img" -c 'mkdir -p /app/hermes-template && cp -r /build/. /app/hermes-template/ && node /app/hermes-template/build.mjs && node /app/hermes-template/smoke.mjs' \
  > /var/log/e2b-hermes-build.log 2>&1 || s=\$?
rm -rf "\$d"
# SSM returns at most 24 KB, so the full log stays on the host and only its tail comes back.
grep -vE '\\[debug\\]' /var/log/e2b-hermes-build.log | tail -n 60
exit \${s:-0}
SH
)
params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()], "executionTimeout": ["3600"]}))' <<<"$script")
cmd=$(aws_ ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)
echo "ssm command $cmd"
until status=$(aws_ ssm get-command-invocation --command-id "$cmd" --instance-id "$instance" \
  --query Status --output text 2>/dev/null) && [ "$status" != InProgress ] && [ "$status" != Pending ]; do sleep 15; done
aws_ ssm get-command-invocation --command-id "$cmd" --instance-id "$instance" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
[ "$status" = Success ]
