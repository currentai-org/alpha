# The guest image for a conversation's E2B sandbox: Hermes at the service image's pin, with the same
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
# Kilo's CLI beside Hermes, unused until the service switches engines: the same release, digests and install as
# deploy/Dockerfile (test_e2b_template.py checks the three ARGs match), so the guest and the service image would
# run the same Kilo.
ARG KILO_VERSION=7.8.27
ARG KILO_SHA512_X64=7f56eceebf11f180623b67c84331081fdc24129c7dac5e83a2e00a46d880f7736b3c3e1ebe284878bb30c418af8bcadb4a3d6c4e9b94530e2d6e1c20b13c1fb7
ARG KILO_SHA512_ARM64=ad262e0188e21c15909ac864e2fbad36aab2f25b0da60ad1a53c14239df4e0620a666ddea0942c9d2665f25bf9d7dd029391dcdadeba394a1ec6774c200a4feb
RUN python -c "import hashlib, io, platform, sys, tarfile, urllib.request; v, want = sys.argv[1], dict(x64=sys.argv[2], arm64=sys.argv[3]); a = dict(x86_64='x64', aarch64='arm64')[platform.machine()]; url = f'https://registry.npmjs.org/@kilocode/cli-linux-{a}/-/cli-linux-{a}-{v}.tgz'; d = urllib.request.urlopen(url, timeout=300).read(); got = hashlib.sha512(d).hexdigest(); sys.exit(f'{url}: sha512 {got} is not the pinned {want[a]}') if got != want[a] else None; tarfile.open(fileobj=io.BytesIO(d)).extractall('/tmp/kilo', filter='data')" "${KILO_VERSION}" "${KILO_SHA512_X64}" "${KILO_SHA512_ARM64}" \
    && mv /tmp/kilo/package/bin /opt/kilo && rm -rf /tmp/kilo \
    && chmod 0711 /opt/kilo/kilo && ln -s /opt/kilo/kilo /usr/local/bin/kilo \
    && got="$(kilo --version)" && echo "kilo --version: $got" \
    && { [ "$got" = "${KILO_VERSION}" ] || { echo "kilo on PATH is not the pinned ${KILO_VERSION}" >&2; exit 1; }; }
# What chat's run-code tools and the agent prompt offer (sandbox_mcp.py's tool descriptions, app.py's
# COMPUTATION_NOTE): guest-libraries.txt, E2B's standard code-interpreter list plus the office formats. The guest
# has no route to PyPI, so a library missing here can't be installed by the agent.
COPY guest-libraries.txt /tmp/guest-libraries.txt
# pip check: a pin here that breaks one of Hermes' own pins fails the build instead of changing Hermes underneath it.
RUN pip install -r /tmp/guest-libraries.txt && rm /tmp/guest-libraries.txt && pip check
