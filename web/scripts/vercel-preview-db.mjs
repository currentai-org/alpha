#!/usr/bin/env node
// vercel-preview-db — give one PR's Vercel preview its own DATABASE_URL, scoped to that git branch
// via Vercel's per-branch env override mechanism (CUR-1327). Without it every preview build — every
// branch — reads the same shared preview DATABASE_URL and runs `drizzle-kit migrate` against it, so
// one branch's DROP COLUMN would break every OTHER open PR's preview the moment it deploys.
//
// Reuses the Neon branch jelastic-preview.yml already creates for this PR (pr-<N> on
// aipotluck-prod-eu) rather than provisioning a second one — a per-PR branch costs one of Neon's Free
// plan's 10-branches-per-project slots, and doubling that per PR halves how many PRs the project can
// hold open. Called from that same workflow, both jobs: `--set` right after "Create or reuse the
// Neon branch" in the deploy job, `--remove` (if: always()) alongside "Delete the Neon branch" in the
// teardown job — one job owns create+delete for this PR's Jelastic env, Neon branch, and Vercel
// override together, so a partial teardown can't leave this one orphaned while the others are
// cleaned (CUR-1332).
//
// Writes DATABASE_URL AND a companion marker, PR_SCOPED_DATABASE=1, to the same branch — the marker
// is what web/scripts/check-preview-db-scope.mjs gates `vercel-build`'s migrate step on, so a caller
// never has to parse or compare connection strings to tell a per-PR override from the shared one.
//
// Usage:
//   node scripts/vercel-preview-db.mjs --set --branch <gitBranch> --database-url <url>
//   node scripts/vercel-preview-db.mjs --remove --branch <gitBranch>
//   node scripts/vercel-preview-db.mjs --get --branch <gitBranch>
// Env: VERCEL_TOKEN must be set. --scope/--project default to this repo's own (current-ai/aipotluck.org).
//
// The CMS (aipotluck-cms) reuses this for its own per-PR database (CUR-4045, cms-preview-db.yml):
//   --key CMS_DATABASE_URL --marker CMS_PR_SCOPED_DATABASE --marker-value <neon endpoint id>
// The defaults below are web's, unchanged. --mark-only writes the marker alone, for a branch whose
// database override someone set by hand: it adopts that override without touching its value. With
// --key/--marker, --get prints whichever key --key names, so `--key <marker>` reads the marker.
//
// --get (CUR-1486) prints the branch's own DATABASE_URL to stdout, meant to be captured directly
// like resolve-deployment-url.mjs. Two distinct exit codes so a caller can tell "shared DB is
// correct" from "the lookup itself failed" without parsing stderr: exit 1 means the branch
// genuinely has no override (expected, safe to fall back); exit 2 means the lookup couldn't run at
// all (bad VERCEL_TOKEN, network, a Vercel API error) — a caller should surface this loudly before
// falling back, since treating it the same as exit 1 would hide a failed lookup.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const MODE = has("set") ? "set" : has("mark-only") ? "mark-only" : has("remove") ? "remove" : has("get") ? "get" : null;
const BRANCH = arg("branch");
const DATABASE_URL = arg("database-url");
const SCOPE = arg("scope", "current-ai");
const PROJECT = arg("project", "aipotluck.org");
const TOKEN = process.env.VERCEL_TOKEN;
const TIMEOUT_MS = Number(arg("timeout", "15000"));
const KEY = arg("key", "DATABASE_URL");
const MARKER_KEY = arg("marker", "PR_SCOPED_DATABASE");
const MARKER_VALUE = arg("marker-value", "1");

const die = (msg) => {
	console.error(`✖ vercel-preview-db FAILED: ${msg}`);
	process.exit(2);
};

if (!MODE) die(`pass --set, --mark-only, --remove, or --get`);
if (!BRANCH) die(`--branch is required`);
if (MODE === "set" && !DATABASE_URL) die(`--set requires --database-url`);
// develop's preview is the shared one and main is production's branch. A PR whose head is
// either would point that branch's preview at its own pr-<N> database on open and delete the override
// on close, so writes refuse them before any API call. --get stays allowed: it only reads. (SOL-179)
if (MODE !== "get" && (BRANCH === "develop" || BRANCH === "main"))
	die(`refusing to ${MODE} a per-PR database override on ${BRANCH}, a shared branch`);
if (!TOKEN) die(`VERCEL_TOKEN is unset`);

const api = async (path, opts, what) => {
	let res;
	try {
		res = await fetch(`https://api.vercel.com${path}`, {
			...opts,
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opts?.headers ?? {}) },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		die(`could not reach ${what} — ${e instanceof Error ? e.message : String(e)}`);
	}
	const body = await res.json().catch(() => null);
	if (!res.ok) die(`${what} returned HTTP ${res.status}: ${JSON.stringify(body)}`);
	return body;
};

const teams = await api("/v2/teams", { method: "GET" }, "the Vercel teams API");
const team = teams.teams?.find((t) => t.slug === SCOPE);
if (!team) die(`no Vercel team with slug "${SCOPE}" — known: ${(teams.teams ?? []).map((t) => t.slug).join(", ")}`);

// Read the project by name rather than searching for it. A search can return a page
// without "aipotluck.org" in it, which would fail a deploy and leave a teardown's override behind.
// `GET /v9/projects/{idOrName}` takes the name directly, and an unknown name is a 404 that api()
// reports with Vercel's own error body. (CUR-2157)
const project = await api(
	`/v9/projects/${encodeURIComponent(PROJECT)}?teamId=${team.id}`,
	{ method: "GET" },
	`the Vercel project "${PROJECT}" under team "${SCOPE}"`
);
if (project?.name !== PROJECT)
	die(`the Vercel project lookup for "${PROJECT}" returned ${JSON.stringify(project?.name)}`);

// All three modes need the current state for this branch — set updates in place where an entry
// already exists (see the --set path below), remove just needs the ids to delete.
const existing = await api(
	`/v9/projects/${project.id}/env?teamId=${team.id}`,
	{ method: "GET" },
	"the Vercel project env API"
);
const forBranch = (key) => existing.envs?.filter((e) => e.key === key && e.gitBranch === BRANCH) ?? [];

// get: passing decrypt=true to the LIST endpoint is a no-op on type:"encrypted" entries — the value
// comes back as a `{"v":"v2","c":"..."}` ciphertext envelope. Fetching the single env by its own id
// returns plaintext.
if (MODE === "get") {
	const [entry] = forBranch(KEY);
	if (!entry) process.exit(1);
	const decrypted = await api(
		`/v9/projects/${project.id}/env/${entry.id}?teamId=${team.id}&decrypt=true`,
		{ method: "GET" },
		"the Vercel single-env API"
	);
	console.log(decrypted.value);
	process.exit(0);
}

const removeAll = async (key) => {
	for (const e of forBranch(key)) {
		await api(
			`/v9/projects/${project.id}/env/${e.id}?teamId=${team.id}`,
			{ method: "DELETE" },
			`deleting ${key} (${e.id})`
		);
		console.log(`== removed ${key} for ${BRANCH} (${e.id})`);
	}
};

if (MODE === "remove") {
	await removeAll(KEY);
	await removeAll(MARKER_KEY);
	console.log(`== done — ${BRANCH} has no per-branch preview database override`);
	process.exit(0);
}

// set: change an existing entry in place rather than delete and re-create it (CUR-1365). A delete
// then create leaves a window where PR_SCOPED_DATABASE does not exist on the project at all, and a
// Vercel automatic build started by the same push reads that marker through
// check-preview-db-scope.mjs within seconds; a read inside the window finds nothing and the
// deployment settles ERROR. A retrigger (CUR-1364) repairs that after the fact; closing the window
// makes it a backstop rather than the only thing between a push and a dead preview.
//
// Writing the new entries before removing the stale ones is not possible: a second POST for a key
// that already exists on the same target and gitBranch returns HTTP 400 `ENV_CONFLICT`, so two
// entries can never coexist. `PATCH /v9/projects/<id>/env/<envId>` returns HTTP 200 and keeps the
// same id, so an existing entry's value changes with no moment where it is absent.
const patch = (e, value, key) =>
	api(
		`/v9/projects/${project.id}/env/${e.id}?teamId=${team.id}`,
		{ method: "PATCH", body: JSON.stringify({ value }) },
		`updating ${key} for ${BRANCH} (${e.id})`
	);
const create = (key, value) =>
	api(
		`/v10/projects/${project.id}/env?teamId=${team.id}`,
		{ method: "POST", body: JSON.stringify({ key, value, type: "encrypted", target: ["preview"], gitBranch: BRANCH }) },
		`creating ${key} for ${BRANCH}`
	);

// Update the first entry in place and delete any others. Extras should not exist — ENV_CONFLICT makes
// them impossible to create through this path — but a hand-made entry or an older version of this
// script could have left one, and silently updating one of two while the other keeps a stale value is
// the kind of half-state that is worse than either.
const upsert = async (key, value) => {
	const [first, ...extras] = forBranch(key);
	if (first) {
		await patch(first, value, key);
		console.log(`== updated ${key} in place for ${BRANCH} (${first.id})`);
	} else {
		await create(key, value);
		console.log(`== created ${key} for ${BRANCH}`);
	}
	for (const e of extras) {
		await api(
			`/v9/projects/${project.id}/env/${e.id}?teamId=${team.id}`,
			{ method: "DELETE" },
			`deleting duplicate ${key} (${e.id})`
		);
		console.log(`== removed a duplicate ${key} for ${BRANCH} (${e.id})`);
	}
	return !first;
};

// DATABASE_URL first and the marker last, on the first push where both are genuinely created. The
// marker is what check-preview-db-scope.mjs gates on, so it must never be visible before the URL it
// promises — a build that sees PR_SCOPED_DATABASE=1 and an absent DATABASE_URL would pass the guard
// and then migrate the shared database, which is the thing this whole mechanism exists to prevent.
if (MODE === "set") await upsert(KEY, DATABASE_URL);
const markerCreated = await upsert(MARKER_KEY, MARKER_VALUE);
// A deployment created before this moment read the marker unset and will skip itself, so the retrigger
// step needs the time (CUR-2238). Only on creation: an in-place update leaves the marker readable
// throughout, so earlier deployments already saw it.
if (markerCreated && process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `marker_created_at=${Date.now()}\n`);
}
console.log(`== ${BRANCH} now has its own preview ${KEY} (${MARKER_KEY}=${MARKER_VALUE})`);
