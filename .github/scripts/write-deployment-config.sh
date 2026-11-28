#!/usr/bin/env bash
# Writes the installation's identity file, web/config/deployment.json (src/lib/deployment.ts), from
# DEPLOYMENT_JSON before deploy.yml uploads the tree to Vercel. The build inlines it, so it sets the hosts
# the deployment serves and links to, its status page, its passkey domain and its mail sender.
#
# The file is this installation's own, so it lives in the deploy environment's DEPLOYMENT_JSON variable
# and never in the repository: a fork or a self-hoster's build keeps the neutral defaults. Unset, the
# build takes those defaults too, with a warning. Workflow logs are public, so this prints key names only.
set -euo pipefail
OUT=web/config/deployment.json
if [ -z "${DEPLOYMENT_JSON:-}" ]; then
	echo "::warning title=deployment identity::DEPLOYMENT_JSON is not set in this environment, so the build has no site host, status page or passkey domain of its own."
	exit 0
fi
if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$DEPLOYMENT_JSON"; then
	echo "::error title=deployment identity::DEPLOYMENT_JSON is not a JSON object."
	exit 1
fi
jq . <<<"$DEPLOYMENT_JSON" > "$OUT"
echo "wrote $OUT with keys: $(jq -r 'keys | join(", ")' "$OUT")"
