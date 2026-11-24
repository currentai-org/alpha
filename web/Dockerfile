# Alpha's web app (web/: the site and the chat) as a plain Node server. The public
# repository's .github/workflows/image.yml publishes its chat build to GHCR on a release tag or a
# manual run; here .github/workflows/web-image.yml builds it and smokes it with a real chat turn.
#
# Build context is the repository root, so the pnpm workspace, its one lockfile and web/'s patches
# are in view: `docker build -f web/Dockerfile .` from the root. web/Dockerfile.dockerignore keeps
# the rest of the repository out of the context.
#
# ADAPTER=node swaps the Vercel adapter for @sveltejs/adapter-node, already a dependency of web/.
# APP_SURFACE (src/lib/surface.ts) empty builds the site with chat under /chat; the published image and
# selfhost/compose.yaml build with APP_SURFACE=chat, the chat at the root of its host.
# GIT_SHA and GIT_REF name the commit inside the image; runtimeEnv.js reads them where Vercel would
# set VERCEL_GIT_COMMIT_*.

# Each base image is pinned by digest on its FROM line, so a rebuild of the same commit gets the same
# operating system, and Dependabot's docker entry (.github/dependabot.yml) proposes each new digest as
# a pull request the image scan runs on. Dependabot reads only a literal FROM line, so no ARG.
#
# The build stages use Node's Debian 13 slim image through AWS's public mirror of Docker Hub's library
# images, so no anonymous pull limit fails a build. The version matches web/.nvmrc's major.
# The image that serves is distroless Node on the same Debian release: Node, glibc, CA certificates and
# nothing else, with no shell or package manager. Most of the base image's scan findings were in
# packages the server never runs (util-linux, PAM, perl, ncurses).

FROM public.ecr.aws/docker/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build
WORKDIR /app
# The version in package.json's packageManager field.
RUN npm install -g pnpm@11.0.8
COPY . .
RUN pnpm install --frozen-lockfile --filter aipotluck-web...
WORKDIR /app/web
ARG GIT_SHA=""
ARG GIT_REF=""
ARG APP_SURFACE=""
ENV ADAPTER=node CI=true GIT_SHA=${GIT_SHA} GIT_REF=${GIT_REF} APP_SURFACE=${APP_SURFACE} NODE_OPTIONS=--max-old-space-size=6144
RUN pnpm exec vite build
# The operator CLIs (`node build/cli/import-open-webui.mjs`) as plain Node scripts, so the image runs
# them with no dev dependency: vite.operator-cli.config.ts.
RUN pnpm build:operator-cli

# Production dependencies only, from the same lockfile: the runtime stage below copies this tree, not
# the build's, so no dev dependency ships. drizzle-kit and vite's tooling bring esbuild's Go binaries,
# which carried every Go finding the image scan reported.
FROM public.ecr.aws/docker/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS prod-deps
WORKDIR /app
RUN npm install -g pnpm@11.0.8
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter aipotluck-web...
# The one directory the process writes, made here because the image that serves has no shell to run
# mkdir: CUSTODIAL_STORAGE_BACKEND=local's files, where selfhost/compose.yaml mounts a volume.
RUN mkdir -p /data/files

# The image that serves, and the last stage, so a build with no --target builds it.
FROM gcr.io/distroless/nodejs24-debian13:latest@sha256:ba59ac9916b424cdfaaa8299695530251535843623a6d8f93d40b0a2ef69e390
ARG GIT_SHA=""
ARG GIT_REF=""
ARG APP_SURFACE=""
LABEL org.opencontainers.image.source="https://github.com/currentai-org/alpha" \
	org.opencontainers.image.revision="${GIT_SHA}" \
	org.opencontainers.image.licenses="MIT"
# The built server imports its production dependencies from node_modules at runtime, and
# db-migrate.mjs needs drizzle-orm, postgres and the drizzle/ folder: the workspace with production
# dependencies only, plus the server the build stage built. Owned by root and read-only to the process.
COPY --from=prod-deps /app /app
COPY --from=build /app/web/build /app/web/build
# A new volume mounted here takes this directory's owner. uid 1000 is the `node` user of the images
# before this one, so a volume they created stays writable.
COPY --from=prod-deps --chown=1000:1000 /data/files /data/files
WORKDIR /app/web
# The base image runs node by absolute path and leaves it off PATH; on PATH, `docker exec <container>
# node …` and the operator CLIs (`node build/cli/<name>.mjs`) work as on the images before this one.
ENV PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
	NODE_ENV=production PORT=3000 HOST=0.0.0.0 GIT_SHA=${GIT_SHA} GIT_REF=${GIT_REF} APP_SURFACE=${APP_SURFACE}
USER 1000:1000
EXPOSE 3000
# /chat/healthcheck answers 200 only when the model registry can serve a turn; a chat-surface build
# serves it at /healthcheck. There is no curl, so Node's own fetch asks.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
	CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.APP_SURFACE==='chat'?'':'/chat')+'/healthcheck').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migrations on every start, as Vercel's build runs them on every deploy (the migrator is idempotent and
# records what it applied), then the server, in the one Node process the base image's entrypoint
# starts, so SIGTERM reaches the server's graceful shutdown.
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["scripts/serve.mjs"]
