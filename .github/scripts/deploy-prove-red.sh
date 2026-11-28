#!/usr/bin/env bash
# deploy.yml's two hooks around a build, including its prove_red input (PROVE_RED).
#   deploy-prove-red.sh identity  keeps a copy of the identity file in $RUNNER_TEMP for the smoke to
#                                 check against; with PROVE_RED=identity it then deletes the build's copy,
#                                 so the build ships without its identity, as a real break would.
#   deploy-prove-red.sh env       prints `vercel deploy` arguments: with PROVE_RED=answer or provider, an
#                                 --env for each base URL in DEAD_PROVIDER, pointed at a closed port, so the
#                                 build's model calls fail while its pages still serve.
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
	answer | provider)
		args=()
		for key in ${DEAD_PROVIDER:?}; do args+=(--env "$key=http://127.0.0.1:9/v1"); done
		echo "${args[*]}"
		echo "::notice title=prove_red::the build's model base URLs point at a closed port" >&2
		;;
	esac
	;;
*) echo "unknown: $1" >&2; exit 2 ;;
esac
