#!/usr/bin/env bash
# Run the sandbox contract suite (api/test_sandbox_backend_contract.py, SANDBOX_CONTRACT_BACKEND=e2b) on the E2B host
# itself, over SSM, so nothing runs on a laptop and the team API key never leaves the host. Same mechanism as
# build-on-host.sh. Usage: run-contract-on-host.sh <instance-id> [aws profile]
# An empty profile ('') uses the ambient credentials, as agent-service-e2b-contract.yml does after assuming its
# OIDC role. Exits with pytest's exit code: 0 when it passed, 1 when a test failed, non-zero for anything else.
# The fixture prefixes every principal with the run's id and kills the sandboxes it made (_FreshKeys.close).
set -euo pipefail
instance=$1 profile=${2-${AWS_PROFILE:?pass the aws profile of the account holding the E2B hosts, or '' for ambient credentials}}
aws_() { if [ -n "$profile" ]; then aws --profile "$profile" "$@"; else aws "$@"; fi; }
here=$(cd "$(dirname "$0")" && pwd)
svc=$here/../..
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
# Only the backend and its test, not api/app.py (the test imports it just for its bwrap fixture): SSM caps a
# command at 100 KB, and app.py alone is over 500 KB. conftest.py puts api/ on sys.path.
mkdir "$ctx/api"
cp "$svc"/api/{test_sandbox_backend_contract,sandbox_e2b,sandbox_backend,conftest}.py "$ctx/api/"
# The pinned versions of the only packages those files import beyond the standard library.
grep -hE '^(e2b|circuitbreaker|aiolimiter|pytest)==' "$svc/requirements.txt" "$svc/requirements-dev.txt" > "$ctx/pins.txt"
bundle=$(tar -C "$ctx" -czf - . | base64 -w0)
# The node-e2b image and the key file are Embed's own (compose.yaml, base-template service), as in build-on-host.sh.
script=$(cat <<SH
set -e
d=\$(mktemp -d); echo "$bundle" | base64 -d | tar -C "\$d" -xzf -
cd /opt/e2b; img=\$(grep '^E2B_NODE_E2B_IMAGE=' .env | cut -d= -f2 | cut -d' ' -f1)
key=\$(docker run --rm -v e2b_seed-state:/run/e2b --entrypoint cat "\$img" /run/e2b/team-api-key)
E2B_API_KEY="\$key" docker run --rm --network host -v "\$d":/w -w /w \
  -e E2B_API_KEY -e E2B_API_URL=http://127.0.0.1:3000 -e E2B_SANDBOX_URL=http://127.0.0.1:3002 -e SANDBOX_CONTRACT_BACKEND=e2b \
  python:3.14-slim sh -c 'set -e; pip install -q --no-cache-dir -r pins.txt; exec python -m pytest -p no:cacheprovider api/test_sandbox_backend_contract.py' \
  > /var/log/e2b-contract.log 2>&1 || s=\$?
rm -rf "\$d"
# SSM returns at most 24 KB, so the full log stays on the host and only its tail (pytest's summary) comes back.
tail -n 60 /var/log/e2b-contract.log
exit \${s:-0}
SH
)
params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()], "executionTimeout": ["1800"]}))' <<<"$script")
cmd=$(aws_ ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --parameters "$params" --query Command.CommandId --output text)
echo "ssm command $cmd"
until status=$(aws_ ssm get-command-invocation --command-id "$cmd" --instance-id "$instance" \
  --query Status --output text 2>/dev/null) && [ "$status" != InProgress ] && [ "$status" != Pending ]; do sleep 15; done
aws_ ssm get-command-invocation --command-id "$cmd" --instance-id "$instance" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
[ "$status" = Success ]
