import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";

const run = promisify(execFile);
const REPO_WEB = new URL("../..", import.meta.url).pathname;

// The standalone DB verifiers (`verify:cleanup`, `verify:drizzle-slice`, `db:verify`) run in CI's
// stateful job and are not part of any vitest project, so a green unit run says nothing about them.
//
// These invoke the PACKAGE SCRIPTS rather than importing the modules, deliberately. The contract is
// process-level: "this script exits 0 when the database is correct". An in-process import keeps passing
// when only the exit is wrong (a teardown abort after every assertion passed). Test the artifact CI
// actually runs.
//
// Stateful project only (serial): each verifier seeds rows, runs a real cleanup/migration check against
// the shared database, and deletes what it seeded. Running these file-parallel with other DB specs
// races on those rows (CUR-93).

const VERIFIERS = [
	{
		script: "verify:cleanup",
		marker: "ALL CHECKS PASSED",
		guards: "TTL garbage collection deletes expired rows and keeps fresh ones (FK order held)",
	},
	{
		script: "verify:drizzle-slice",
		marker: "ALL CHECKS PASSED",
		guards: "the Drizzle query slice returns what the hand-written SQL did",
	},
	{
		script: "db:verify",
		marker: "matches the Drizzle schema",
		guards: "the live database schema matches the Drizzle definitions",
	},
] as const;

describe("standalone DB verifiers — exit 0 as whole processes, not just as assertions", () => {
	for (const { script, marker, guards } of VERIFIERS) {
		it(`\`pnpm ${script}\` exits 0 — ${guards}`, async () => {
			const { stdout } = await run("pnpm", ["run", script], {
				cwd: REPO_WEB,
				env: process.env,
				maxBuffer: 8 * 1024 * 1024,
			});
			// execFile rejects on any nonzero exit, so reaching here IS the exit-0 assertion. The
			// marker check is the second half: a script that exits 0 without doing its work would
			// otherwise pass. Both halves matter: a script can print the marker and then
			// crash (exit 134), so neither check alone is enough.
			expect(stdout).toContain(marker);
		}, 120_000);
	}
});
