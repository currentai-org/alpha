#!/usr/bin/env bash
# Migrates the deployment's database before deploy.yml deploys the build that needs it, so a migration that
# fails stops the deploy before any build serves the new code. deploy.yml takes the Neon snapshot first.
# The build still runs db-migrate too (web/package.json vercel-build), where it finds nothing to apply.
#
#   NEON_API_KEY=... NEON_PROJECT_ID=... NEON_BRANCH_ID=... .github/scripts/deploy-migrate.sh
# web's dependencies must be installed. The connection URI carries the password, so it is masked before
# anything can print it, and db-migrate.mjs never prints it either.
set -euo pipefail
url=$(.github/scripts/neon-snapshot.sh url)
echo "::add-mask::$url"
pass=${url#*://}
pass=${pass#*:}
pass=${pass%%@*}
echo "::add-mask::$pass"
cd web
DATABASE_URL=$url node scripts/db-migrate.mjs
