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

# Docker Hub's library images through AWS's public mirror, so no anonymous pull limit fails a build.
# The version matches web/.nvmrc's major.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
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

FROM ${NODE_IMAGE}
ARG GIT_SHA=""
ARG GIT_REF=""
ARG APP_SURFACE=""
LABEL org.opencontainers.image.source="https://github.com/currentai-org/alpha" \
	org.opencontainers.image.revision="${GIT_SHA}" \
	org.opencontainers.image.licenses="MIT"
WORKDIR /app
# The built server imports its dependencies from node_modules at runtime, and db-migrate.mjs needs
# drizzle-orm, postgres and the drizzle/ folder, so the installed workspace comes along whole. Owned
# by root and read-only to the process, which runs as the image's unprivileged `node` user.
COPY --from=build /app /app
# The one directory the process writes: CUSTODIAL_STORAGE_BACKEND=local's files, where
# selfhost/compose.yaml mounts a volume. A new volume takes this directory's owner.
RUN mkdir -p /data/files && chown node:node /data/files
# The operator CLIs (`pnpm import:open-webui` and the rest) run through vite-node, which loads
# vite.config.ts: it writes the bundled config to node_modules/.vite-temp, its cache to
# node_modules/.vite, and SvelteKit's sync rewrites .svelte-kit (generated types and env). The
# server runs from build/ and never reads .svelte-kit, so those three are the node user's and the rest
# of the tree stays read-only.
RUN mkdir -p /app/web/node_modules/.vite-temp /app/web/node_modules/.vite /app/web/.svelte-kit \
	&& chown node:node /app/web/node_modules/.vite-temp /app/web/node_modules/.vite \
	&& chown -R node:node /app/web/.svelte-kit
WORKDIR /app/web
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 GIT_SHA=${GIT_SHA} GIT_REF=${GIT_REF} APP_SURFACE=${APP_SURFACE}
USER node
EXPOSE 3000
# /chat/healthcheck answers 200 only when the model registry can serve a turn; a chat-surface build
# serves it at /healthcheck. The slim image has no curl, so Node's own fetch asks.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.APP_SURFACE==='chat'?'':'/chat')+'/healthcheck').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Migrations on every start, as Vercel's build runs them on every deploy: the migrator is idempotent
# and records what it applied. `exec` replaces the shell with node, so SIGTERM reaches the server's
# graceful shutdown.
CMD ["sh", "-c", "node scripts/db-migrate.mjs && exec node build"]
