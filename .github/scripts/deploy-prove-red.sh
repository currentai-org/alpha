#!/usr/bin/env bash
# deploy.yml's two hooks around a build, including its prove_red input (PROVE_RED).
#   deploy-prove-red.sh identity  keeps a copy of the identity file in $RUNNER_TEMP for the smoke to
#                                 check against; with PROVE_RED=identity it then deletes the build's copy,
#                                 so the build ships without its identity, as a real break would.
#   deploy-prove-red.sh env       prints `vercel deploy` arguments for a dead upstream on a closed port.
#                                 PROVE_RED=answer: every input screen the turn can use, Shieldstral
#                                 (GUARD_SHADOW_URL) and, with the s1-safety-judge flag on, the S1 judge
#                                 (ZENTROPI_S1_ENDPOINT_URL, web/config/safetyScreen.ts), whose env var wins
#                                 over the deployed address. A screen that cannot answer fails closed, so
#                                 the build comes up and every turn is declined, as a broken screen would.
#                                 PROVE_RED=default-model: GIT_REF names a per-ticket branch, so the build
#                                 puts TASK_MODEL ahead of the picker's default (mistralKey.ts), as a
#                                 production build misread as a preview once did.
#                                 PROVE_RED=provider: every model base URL in DEAD_PROVIDER, which also
#                                 leaves the model list empty, so the build never comes up, as in a real
#                                 provider outage.
set -euo pipefail
file=web/config/deployment.json
case ${1:?identity or env} in
identity)
	if [ -f "$file" ]; then cp "$file" "${RUNNER_TEMP:?}/deployment.json"; fi
	if [ "${PROVE_RED:-none}" = identity ]; then
		rm -f "$file"
		echo "::notice title=prove_red::the build ships without $file; the smoke checks it against the copy in RUNNER_TEMP"
	fi
	;;
env)
	case ${PROVE_RED:-none} in
	answer)
		echo "--env GUARD_SHADOW_URL=http://127.0.0.1:9 --env ZENTROPI_S1_ENDPOINT_URL=http://127.0.0.1:9"
		echo "::notice title=prove_red::the build's input screens point at a closed port" >&2
		;;
	default-model)
		echo "--env GIT_REF=prove-red/a-ticket-branch"
		echo "::notice title=prove_red::the build reads its ref as a per-ticket branch, so its default model is TASK_MODEL" >&2
		;;
	provider)
		args=()
		for key in ${DEAD_PROVIDER:?}; do args+=(--env "$key=http://127.0.0.1:9/v1"); done
		echo "${args[*]}"
		echo "::notice title=prove_red::the build's model base URLs point at a closed port" >&2
		;;
	esac
	;;
*) echo "unknown: $1" >&2; exit 2 ;;
esac
