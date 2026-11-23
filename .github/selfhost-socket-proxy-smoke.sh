#!/usr/bin/env bash
# Starts only the sockguard service from selfhost/compose.yaml (agent profile) and sends container creates
# through it with the docker CLI. Fails unless:
#   - a plain create with no-new-privileges passes (so the policy file loaded and the proxy forwards), and
#     an internal network can be created, connected to and removed (the sandbox gives each conversation one);
#   - the same create is refused by the proxy, with sockguard's own refusal message, when it adds any one of:
#     `-v /:/host`, `-v /var/run/docker.sock:/var/run/docker.sock`, `--mount type=bind,src=/,dst=/host`,
#     a local-driver volume bound to / (`--mount type=volume,...,volume-opt=o=bind,volume-opt=device=/`),
#     `--privileged`, `--cap-add SYS_ADMIN`, `--device /dev/null`, `--pid host`, `--ipc host`,
#     `--network host` or `--security-opt seccomp=unconfined`;
#   - agent-service's docker sandbox backend (agent-service/api/sandbox_docker.py), pointed at the proxy, passes
#     the sandbox contract tests (test_sandbox_backend_contract.py: a command runs, files persist between calls,
#     run-code reaches no network, a timeout stops a command, stdio for agent mode) and the live hardening tests
#     (test_sandbox_docker_live.py: uid 1000, no capability, no-new-privileges, read-only root, the agent tier
#     reaches the gateway and nothing else, and a privileged create, a host-root bind and a root exec sent the
#     way the backend sends them come back 403), with none skipped.
# Each refused create differs from the passing one by that one flag, so the refusal is for that flag.
# Run from the repository root by the self-host CI workflow (job socket-proxy). Linux only: it
# reaches the proxy at its container address, which Docker Desktop does not route to the host.
set -euo pipefail

cd "$(dirname "$0")/../selfhost"
project=alpha-socket-proxy-smoke
# Pulled straight from the daemon, not through the proxy, whose policy refuses pulls.
image=${SOCKET_PROXY_SMOKE_IMAGE:-public.ecr.aws/docker/library/alpine:3.22}
export DOCKER_SOCK_GID=${DOCKER_SOCK_GID:-$(stat -c %g /var/run/docker.sock)}
# compose.yaml requires this for the web service; nothing here starts web.
export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-unused-by-this-check}
compose() { docker compose -p "$project" --profile agent "$@"; }

created=()
cleanup() {
	for id in "${created[@]}"; do docker rm -f "$id" >/dev/null 2>&1 || true; done
	docker network rm "$project-probe" >/dev/null 2>&1 || true
	docker rm -f "$project-gateway" >/dev/null 2>&1 || true
	# Anything the backend tests left, by the label every sandbox and its network carries.
	docker ps -aq --filter label=org.aipotluck.sandbox=1 | xargs -r docker rm -f >/dev/null 2>&1 || true
	docker network ls -q --filter label=org.aipotluck.sandbox=1 | xargs -r docker network rm >/dev/null 2>&1 || true
	compose logs --no-color sockguard >"${SOCKET_PROXY_LOG:-/dev/null}" 2>&1 || true
	compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker pull -q "$image" >/dev/null
compose up -d --wait sockguard
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$project-sockguard-1")
proxy="tcp://$ip:2375"
echo "sockguard: $(docker inspect -f '{{.Config.Image}}' "$project-sockguard-1") at $proxy"

fail=0

if control=$(docker -H "$proxy" create --security-opt no-new-privileges "$image" true 2>&1); then
	created+=("$control")
	echo "PASS control: a plain create went through the proxy (${control:0:12})"
else
	echo "FAIL control: a plain create was refused, so the refusals below prove nothing: $control"
	fail=1
fi

if docker -H "$proxy" network create --internal "$project-probe" >/dev/null &&
	docker -H "$proxy" network connect "$project-probe" "${control:-none}" &&
	docker -H "$proxy" network disconnect "$project-probe" "${control:-none}" &&
	docker -H "$proxy" network rm "$project-probe" >/dev/null; then
	echo "PASS control: internal network create, connect, disconnect and remove went through the proxy"
else
	echo "FAIL control: the network lifecycle a conversation's sandbox needs was refused"
	fail=1
fi

refused() {
	local name=$1
	shift
	local out
	if out=$(docker -H "$proxy" create --security-opt no-new-privileges "$@" "$image" true 2>&1); then
		created+=("$out")
		echo "FAIL $name: the proxy let it through (container ${out:0:12})"
		fail=1
	elif grep -q 'request denied by sockguard policy' <<<"$out"; then
		echo "PASS $name: refused: $out"
	else
		echo "FAIL $name: failed, but not with the proxy's refusal: $out"
		fail=1
	fi
}
refused "host root bind (-v /:/host)" -v /:/host
refused "Docker socket bind (-v /var/run/docker.sock)" -v /var/run/docker.sock:/var/run/docker.sock
refused "host root bind mount (--mount type=bind)" --mount type=bind,src=/,dst=/host
refused "local-driver volume bound to host root (--mount type=volume)" \
	--mount type=volume,dst=/host,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/
refused "privileged (--privileged)" --privileged
refused "added capability (--cap-add SYS_ADMIN)" --cap-add SYS_ADMIN
refused "device (--device /dev/null)" --device /dev/null
refused "host PID namespace (--pid host)" --pid host
refused "host IPC namespace (--ipc host)" --ipc host
refused "host network (--network host)" --network host
refused "unconfined seccomp (--security-opt seccomp=unconfined)" --security-opt seccomp=unconfined

# The proxy's own reason for each refusal, from its access log.
compose logs --no-color sockguard 2>/dev/null | grep -o '"reason":"container create denied[^"]*\(\\"[^"]*\)*"' || true

# The sandbox backend through the same proxy. The image has the python3 and bash the contract tests run, and
# is pulled straight from the daemon (the proxy refuses pulls), then named by digest as the backend requires.
# The gateway stand-in is any running container: agent sandboxes must resolve it by name and reach nothing else.
sandbox_tag=${SANDBOX_CONTRACT_IMAGE_TAG:-public.ecr.aws/docker/library/python:3.12-slim}
docker pull -q "$sandbox_tag" >/dev/null
sandbox_image=$(docker inspect -f '{{index .RepoDigests 0}}' "$sandbox_tag")
docker run -d --name "$project-gateway" "$image" sleep 600 >/dev/null
venv=$(mktemp -d)
python3 -m venv "$venv"
"$venv/bin/pip" install -q pytest==9.2.0 docker==7.1.0
echo "sandbox backend: $sandbox_image through $proxy"
set +e
DOCKER_HOST=$proxy SANDBOX_CONTRACT_BACKEND=docker SANDBOX_CONTRACT_IMAGE=$sandbox_image \
	SANDBOX_CONTRACT_GATEWAY=$project-gateway "$venv/bin/python" -m pytest -p no:cacheprovider -v -s -rs \
	../agent-service/api/test_sandbox_backend_contract.py ../agent-service/api/test_sandbox_docker_live.py \
	>"$venv/sandbox-backend.log" 2>&1
code=$?
set -e
cat "$venv/sandbox-backend.log"
if [ "$code" -ne 0 ]; then
	echo "FAIL sandbox backend: its tests through the proxy exited $code"
	fail=1
elif grep -q ' SKIPPED' "$venv/sandbox-backend.log"; then
	echo "FAIL sandbox backend: a test was skipped, so it proved nothing"
	fail=1
else
	echo "PASS sandbox backend: $(grep -oE '[0-9]+ passed' "$venv/sandbox-backend.log" | tail -n 1) through the proxy, none skipped"
fi

if [ "$fail" -ne 0 ]; then
	echo "SOCKET PROXY SMOKE FAIL"
	exit 1
fi
echo "SOCKET PROXY SMOKE PASS"
