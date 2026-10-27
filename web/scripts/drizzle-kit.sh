#!/bin/sh
# drizzle-kit with Maglev and concurrent Sparkplug off. Every db:* script that runs drizzle-kit goes
# through here (CUR-2010).
#
# On Node 24, drizzle-kit can print its last line and then never exit. It loads drizzle.config.ts
# through tsx, and on a cold tsx cache, which every CI run and every fresh worktree has, tsx compiles
# with esbuild. process.exit() then joins a V8 compile worker that is parked waiting for a main-thread
# GC that can no longer run (nodejs/node#64274). On a CI runner with a cold cache about 1 run in 70
# hangs without these flags and none do with them. NODE_OPTIONS rejects V8 flags, so node is invoked directly rather than through the bin shim.
exec node --no-maglev --no-concurrent-sparkplug "$(dirname "$0")/../node_modules/drizzle-kit/bin.cjs" "$@"
