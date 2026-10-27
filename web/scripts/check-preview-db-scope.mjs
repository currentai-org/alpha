// Fail a preview DEPLOY BUILD that would run `drizzle-kit migrate` against the shared preview
// database from a branch that isn't `develop` (CUR-1327).
//
//   node scripts/check-preview-db-scope.mjs
//
// WHY. A Vercel preview build that reads the shared `preview` DATABASE_URL runs its migration
// against a database every other open PR's preview also serves from, so a DROP COLUMN on one
// branch would break every sibling preview the moment it deployed. jelastic-preview.yml
// therefore writes each PR branch its own per-branch DATABASE_URL override (vercel-preview-db.mjs) scoped
// via Vercel's gitBranch mechanism, alongside a marker var, PR_SCOPED_DATABASE=1, on the same
// branch. This is the other half: gate the migrate step itself so a build that somehow reaches
// `vercel-build` without that marker fails loud instead of silently migrating the shared database —
// a late-arriving override, a race between the two workflows, or a preview branch this repo's own
// per-PR provisioning never got a chance to run for (paths-ignore, a direct push, a manual deploy).
//
// `develop` is EXEMPT, not scoped — it is the one intentionally-shared long-lived preview
// (docs/guides/env-and-secrets.md), reading the shared config on purpose. Every other preview branch
// must carry the marker or this fails.
//
// Production and local dev builds are exempt outright: `VERCEL_ENV` is only ever "preview" for a
// branch/PR deploy — this never runs on `main` or on a local `pnpm dev`.
const env = process.env.VERCEL_ENV;
const ref = process.env.VERCEL_GIT_COMMIT_REF;
const scoped = process.env.PR_SCOPED_DATABASE === "1";

if (env !== "preview") {
	console.log(`check-preview-db-scope: OK — VERCEL_ENV is "${env ?? "unset"}", not "preview". Nothing to gate.`);
} else if (ref === "develop") {
	console.log(`check-preview-db-scope: OK — develop is the one intentionally-shared preview, exempt by design.`);
} else if (scoped) {
	console.log(`check-preview-db-scope: OK — PR_SCOPED_DATABASE=1, this branch (${ref}) has its own database.`);
} else {
	console.error(
		`check-preview-db-scope: FAIL — this is a preview build on branch "${ref ?? "unknown"}", not develop, and ` +
			`PR_SCOPED_DATABASE is not "1". Migrating here would run drizzle-kit against the shared preview ` +
			`database and can break every other open PR's preview (CUR-1327). Expected jelastic-preview.yml's ` +
			`deploy job to have written a per-branch DATABASE_URL + PR_SCOPED_DATABASE override before this build ` +
			`ran (web/scripts/vercel-preview-db.mjs --set) — it either hasn't run yet, raced this build, or never ` +
			`ran for this branch (e.g. an agent-service-only PR, which jelastic-preview.yml's own paths-ignore ` +
			`skips — but that PR's Vercel build should also have been skipped by vercel-ignore-build.mjs; if ` +
			`you're seeing this failure, check why that skip didn't happen).`
	);
	process.exit(1);
}
