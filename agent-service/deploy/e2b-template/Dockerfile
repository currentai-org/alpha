# The guest image for a conversation's E2B sandbox (CUR-4482): Hermes at the service image's pin, with the same
# local patches, plus the run-code tools' libraries. It carries no credential and no agent-service code; the
# service drives Hermes over stdio and the sandbox host adds the gateway grant outside the guest.
# Built by build.mjs on the E2B host's own template-manager. HERMES_SHA must equal deploy/Dockerfile's
# (test_e2b_template.py checks it), or the two places agent mode runs would be different agents. The ARG values
# are unquoted because E2B's Dockerfile reader keeps quotes as part of the value.
FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ARG HERMES_GIT_URL=https://github.com/NousResearch/hermes-agent
ARG HERMES_SHA=818c13be1dc4fd28987e1e881a9408224afd4535
COPY hermes/ /tmp/hermes-patches/
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# Only the pinned commit: a full clone overflows the build VM's disk.
RUN git init -q /opt/hermes \
    && git -C /opt/hermes fetch -q --depth 1 "${HERMES_GIT_URL}" "${HERMES_SHA}" \
    && git -C /opt/hermes checkout -q FETCH_HEAD \
    && for p in /tmp/hermes-patches/*.patch; do \
           [ -e "$p" ] || break; \
           git -C /opt/hermes apply --verbose "$p"; \
       done \
    && pip install -e "/opt/hermes[acp]" \
    && rm -rf /tmp/hermes-patches \
    && hermes --version && hermes acp --check \
    && python -m compileall -q -j 0 /opt/hermes
# What chat's run-code tools and the agent prompt offer (sandbox_mcp.py's tool descriptions, app.py's
# COMPUTATION_NOTE): guest-libraries.txt, E2B's standard code-interpreter list plus the office formats. The guest
# has no route to PyPI, so a library missing here can't be installed by the agent (CUR-4106).
COPY guest-libraries.txt /tmp/guest-libraries.txt
# pip check: a pin here that breaks one of Hermes' own pins fails the build instead of changing Hermes underneath it.
RUN pip install -r /tmp/guest-libraries.txt && rm /tmp/guest-libraries.txt && pip check
