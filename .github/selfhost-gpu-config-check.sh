#!/usr/bin/env bash
# selfhost/compose.gpu.yaml, checked without a GPU: no CI runner has one, so this proves only what the
# merged compose config asks Docker for, not that a model runs on a GPU (selfhost/README.md says so).
#
#   .github/selfhost-gpu-config-check.sh
#
# With the local and safety profiles, `docker compose -f compose.yaml -f compose.gpu.yaml config` must
# give llama and shieldstral an NVIDIA device request for every GPU with the gpu capability, the pinned
# server-cuda image, and LLAMA_ARG_N_GPU_LAYERS=all; compose.yaml alone must give neither service a device
# request, so the override is what adds it. Then both pinned images must carry the same llama.cpp release
# label, so a bump of the CPU pin that leaves the CUDA pin behind fails here (needs registry access).
# Prints one PASS/FAIL line per claim and GPU CONFIG PASS or GPU CONFIG FAIL last; exits 1 on any FAIL.
# Needs docker compose and jq. Starts nothing.
set -euo pipefail
cd "$(dirname "$0")/../selfhost"

# compose.yaml reads .env (env_file) and requires BETTER_AUTH_SECRET; a checkout has neither.
if [ ! -f .env ]; then
	cp .env.example .env
	trap 'rm -f .env' EXIT
fi
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-gpu-config-check}"
# The defaults are what is checked, not whatever this shell or .env overrides them with.
unset LLAMACPP_IMAGE LLAMA_ARG_N_GPU_LAYERS

fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
profiles=(--profile local --profile safety)

gpu=$(docker compose -f compose.yaml -f compose.gpu.yaml "${profiles[@]}" config --format json)
cpu=$(docker compose -f compose.yaml "${profiles[@]}" config --format json)

for svc in llama shieldstral; do
	dev=$(jq -c --arg s "$svc" '.services[$s].deploy.resources.reservations.devices // []' <<<"$gpu")
	echo "$svc devices: $dev"
	if jq -e 'any(.[]; .driver == "nvidia" and (.count == -1 or .count == "all") and ((.capabilities // []) | index("gpu")))' <<<"$dev" >/dev/null; then
		pass "$svc: the merged config requests every NVIDIA GPU with the gpu capability"
	else
		bad "$svc: no NVIDIA device request in the merged config"
	fi
	img=$(jq -r --arg s "$svc" '.services[$s].image' <<<"$gpu")
	echo "$svc image: $img"
	case "$img" in
		ghcr.io/ggml-org/llama.cpp:server-cuda@sha256:*) pass "$svc: runs the server-cuda image pinned by digest" ;;
		*) bad "$svc: image is $img, not llama.cpp's server-cuda pinned by digest" ;;
	esac
	layers=$(jq -r --arg s "$svc" '.services[$s].environment.LLAMA_ARG_N_GPU_LAYERS // "unset"' <<<"$gpu")
	if [ "$layers" = all ]; then
		pass "$svc: LLAMA_ARG_N_GPU_LAYERS=all"
	else
		bad "$svc: LLAMA_ARG_N_GPU_LAYERS is $layers, not all"
	fi
	base=$(jq -c --arg s "$svc" '.services[$s].deploy.resources.reservations.devices // []' <<<"$cpu")
	if [ "$base" = "[]" ]; then
		pass "$svc: compose.yaml alone requests no device"
	else
		bad "$svc: compose.yaml alone already requests $base, so the override proves nothing"
	fi
done

# The same llama.cpp release on CPU and on CUDA.
release() { # image ref -> its org.opencontainers.image.version label, or empty
	docker buildx imagetools inspect "$1" --format '{{json .Image}}' 2>/dev/null \
		| grep -o '"org.opencontainers.image.version": *"[^"]*"' | head -n 1 | sed 's/.*: *"//; s/"$//'
}
cpu_img=$(jq -r '.services.llama.image' <<<"$cpu")
gpu_img=$(jq -r '.services.llama.image' <<<"$gpu")
cpu_rel=$(release "$cpu_img" || true)
gpu_rel=$(release "$gpu_img" || true)
echo "releases: cpu ${cpu_rel:-unknown} ($cpu_img), cuda ${gpu_rel:-unknown} ($gpu_img)"
if [ -z "$cpu_rel" ] || [ -z "$gpu_rel" ]; then
	bad "could not read the release label of both pinned images from the registry"
elif [ "$cpu_rel" = "$gpu_rel" ]; then
	pass "the CPU and CUDA pins are the same llama.cpp release ($cpu_rel)"
else
	bad "compose.yaml pins llama.cpp $cpu_rel and compose.gpu.yaml pins $gpu_rel: bump the CUDA digest with the CPU one"
fi

if [ "$fail" = 0 ]; then echo "GPU CONFIG PASS"; else echo "GPU CONFIG FAIL"; fi
exit "$fail"
