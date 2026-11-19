# Public AI Agent Service — single image, two roles (app | proxy), selected by the container command.
# Plane B (app) runs the agent credential-free; Plane A (proxy) holds the real model token. See deploy/README.md.
# 3.14: Hermes gates every core dependency on python_version >= '3.14' since upstream e1020f32d4, so on
# 3.13 `pip install -e` installs Hermes with no dependencies and the smoke below fails on `import ruamel`.
FROM python:3.14-slim AS seccomp
# The sandbox's syscall filter, compiled once here so the runtime image carries only the BPF it loads.
# deploy/seccomp/gen.c says what it denies and why.
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/seccomp/gen.c /tmp/gen.c
RUN gcc -O2 -Wall -Werror -o /tmp/gen /tmp/gen.c -lseccomp && /tmp/gen /tmp/seccomp.bpf

FROM python:3.14-slim AS base

# bwrap = the execution sandbox (AGENT_SANDBOX=bwrap); ca-certificates for upstream TLS.
# nftables = the EGRESS half of that sandbox. bwrap unshares pid/ipc/uts but not net, so without these
# rules a process inside the sandbox could reach the open internet. util-linux supplies setpriv, which
# deploy/entrypoint.sh uses to drop root again the moment the rules are in.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bubblewrap ca-certificates git nftables util-linux \
    && rm -rf /var/lib/apt/lists/*

# Pin Hermes to a public upstream base commit, so a working build stays working as upstream moves and
# there is no fork to maintain. To build from a fork instead, set HERMES_GIT_URL/HERMES_SHA to it.
ARG HERMES_GIT_URL="https://github.com/NousResearch/hermes-agent"
ARG HERMES_SHA="818c13be1dc4fd28987e1e881a9408224afd4535"  # v0.21.6
# Local patches applied on top of that pinned base, in filename order. This is deliberately NOT a fork:
# the URL above still points at stock upstream, the diff stays reviewable in our own code review, and an
# upstream bump that invalidates a patch fails the BUILD rather than drifting quietly. Every patch here
# needs a stated EXIT CONDITION, or it becomes a fork by accumulation.
#   0001 — unused. Upstream resolves an ACP session's toolsets from `platform_toolsets.acp` in
#          config.yaml (acp_adapter/session.py `_make_agent`), and api/acp_client.py
#          `_write_acp_toolsets` writes that key per attempt, so no patch is needed for it. The number
#          stays free so the remaining patch keeps its name.
#   0002 — acp-confirm-execute. Upstream's `maybe_require_edit_approval` (acp_adapter/edit_approval.py)
#          only builds a proposal for write_file/patch, so without this patch a
#          terminal/process/execute_code call never reaches request_permission, and a fully-trusted
#          `staged` caller would get unconfirmed shell access while an edit/delete-kind call pauses for
#          a human. The patch adds a sibling module, acp_adapter/execute_approval.py, that proposes
#          those three tool names from the SAME model_tools.py chokepoint, with kind="execute".
#          api/acp_client.py's _ALWAYS_CONFIRM_KINDS on the agent-service side is what routes that kind
#          to a real confirm rather than auto-allowing it. The terminal confirm-card summary splits a
#          multi-stage pipe into its stages and names each stage's binary and redirection target.
#          EXIT: no upstream issue tracks this — it is this service's own trust-tier design,
#          not a stock Hermes gap. Delete only if Hermes ever grows a first-class per-call execute
#          confirm hook of its own that this could sit on top of instead of standing beside.
COPY deploy/hermes/ /tmp/hermes-patches/

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# Runtime deps from the repo's requirements.txt — SINGLE source of truth shared with local
# dev (Makefile), so the image and a dev venv can't drift. (build context = repo root.)
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt
# Clone the pinned base and install. Fail LOUD if any step breaks — a successful build must guarantee a
# working app role (no silent half-image).
# `git apply` with no --force and no fallback: a patch that no longer applies means the pinned base
# moved under it, and the only safe outcome is a failed build. Silently skipping it would ship an image
# whose behaviour differs from the config that assumes the patch is there.
# Upstream's setup.py HARD-BLOCKS a normal `pip install` build: a _GuardedSdist / _GuardedBdistWheel
# cmdclass raises "Building wheels or sdists for hermes-agent is not supported" unless
# HERMES_NIX_BUILD=1. The shell installer, the official Docker image and Nix are the paths it allows,
# and its own error text names an editable install (`uv pip install -e .`) as the way to build from a
# plain source checkout. `pip install -e` invokes neither guarded command (`Preparing editable metadata`
# succeeds where a normal install fails at the wheel-build step), so this clones to /opt/hermes and
# installs from there. It is not /tmp because an editable install points at the source tree, which must
# survive to runtime.
RUN git clone "${HERMES_GIT_URL}" /opt/hermes \
    && git -C /opt/hermes checkout "${HERMES_SHA}" \
    && for p in /tmp/hermes-patches/*.patch; do \
           [ -e "$p" ] || break; \
           echo "applying $(basename "$p")"; \
           git -C /opt/hermes apply --verbose "$p"; \
       done \
    && pip install -e "/opt/hermes[acp,mcp]" \
    && rm -rf /tmp/hermes-patches
# The [acp] extra pulls agent-client-protocol so `hermes acp` is available for the AGENT_ACP transport
# (streaming-spec §3/§7.1). It's already present at the pinned SHA above (no bump needed); when AGENT_ACP
# is unset the subcommand is simply unused, so this stays safe for the default oneshot path.
# The [mcp] extra is what Hermes' tools/mcp_tool.py needs to connect to the MCP servers that
# AGENT_MCP_SERVERS passes on new_session. Without it Hermes skips every server at debug level and the
# session simply has no MCP tools — so the import is smoke-checked here instead of discovered in prod.
RUN hermes --version && hermes acp --check \
    && python -c "import mcp.client.streamable_http, httpx2"   # build-time smoke: binary, ACP and MCP deps import
# Compile Hermes to bytecode now, as root. /opt/hermes is root-owned and the agent runs as uid 10001,
# so without this every `hermes acp` start compiles thousands of modules from source and throws the
# result away. On a throttled shared CPU that compile is most of the wait before `session/new`. No
# `|| true`: a file that stops compiling should fail the build, not quietly bring the cost back.
RUN python -m compileall -q -j 0 /opt/hermes

# Non-root by default (defense-in-depth) AND required for bwrap in a container: tested under Docker, the
# agent (uid 10001) uses bwrap's unprivileged user-namespace path; root instead takes the privileged mount
# path which fails "make / slave: EPERM" inside a container. Fly's Firecracker is a real-kernel microVM, so
# its userns support is unverified — if bwrap can't start there, --build-arg RUN_USER=root is the fallback
# (privileged caps, no userns). Keep AGENT_SANDBOX_REQUIRED=1 so a broken sandbox fails closed, never leaks.
RUN useradd -m -u 10001 agent
WORKDIR /srv
COPY api/ /srv/api/
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=seccomp /tmp/seccomp.bpf /etc/agent-sandbox/seccomp.bpf
RUN mkdir -p /data && chown -R agent:agent /srv /data && chmod +x /usr/local/bin/entrypoint.sh
# The container starts as ROOT and entrypoint.sh drops to uid 10001 before exec'ing the server. That is a
# narrower thing than it looks: root exists for the length of one `nft -f`, and the agent still runs as
# 10001 under bwrap's unprivileged user-namespace path, which is what the note above requires. Installing
# packet filters needs NET_ADMIN and there is no way to have it later — a process that has already dropped
# cannot pick it back up. Set AGENT_RUN_UID=0 to skip the drop (local debugging only; bwrap will then take
# the privileged mount path and fail in a container).
ARG RUN_USER=root
USER ${RUN_USER}
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# The commit this image was built from, so /healthz can name it. Deliberately LAST of the build args —
# it changes every build, and anything below it is re-run each time. Unset is reported as "unknown"
# rather than omitted: a deploy that forgot --build-arg GIT_SHA must look different from one that has
# it, or "which code is running" becomes unanswerable exactly when a tester reports something odd.
ARG GIT_SHA=""
ENV AGENT_BUILD_SHA=${GIT_SHA}

# HERMES_BIN resolves on PATH inside the image; the DB lives on a mounted volume (see app.yaml PVC).
ENV HERMES_BIN=hermes \
    AGENT_DB_PATH=/data/tasks.db \
    AGENT_SANDBOX=bwrap \
    AGENT_MODEL_REQUIRED=1 \
    AGENT_MODEL_PROXY_REQUIRED=1 \
    AGENT_MODEL_PROVIDER=huggingface \
    PYTHONUNBUFFERED=1
WORKDIR /srv/api
EXPOSE 8731

# Default = app role. Proxy role overrides command to: uvicorn proxy:app (see proxy.yaml).
# serve.py is uvicorn with a drain on the stop signal, so a deploy lets running tasks finish.
CMD ["python", "serve.py"]
