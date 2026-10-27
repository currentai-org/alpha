import { execFileSync, spawn } from "node:child_process";
import postgres from "postgres";
import { describe, it, expect, afterAll } from "vitest";

import { migrationDatabaseUrl } from "../lib/migrationDatabaseUrl.mjs";

// Each child gets its own ceiling, well under the test's 120s, and a failure rethrows with the
// command and everything it printed, so a hung child is identifiable (CUR-2010).
//
// On timeout the child's whole process group is listed and killed, and the failure says whether the
// direct child had exited, because a grandchild holding the output pipe open looks the same as a
// hung child from here.
const CHILD_TIMEOUT_MS = 50_000;
function run(cmd: string, args: string[]): Promise<void> {
	const started = Date.now();
	const child = spawn(cmd, args, { cwd: WEB, env: process.env, detached: true });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	let exited = "the direct child had not exited";
	child.on("exit", (code, signal) => {
		exited = `the direct child exited ${code ?? signal} after ${Date.now() - started}ms`;
	});
	const output = () => `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			let group: string;
			try {
				group = execFileSync("ps", ["-e", "-o", "pid,ppid,pgid,stat,wchan:24,etimes,args"], { encoding: "utf8" })
					.split("\n")
					.filter((line, i) => i === 0 || line.trim().split(/\s+/)[2] === String(child.pid))
					.join("\n");
			} catch (e) {
				group = `ps failed: ${String(e)}`;
			}
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// The group can already be empty; the close event still has to fire.
			}
			reject(
				new Error(
					`\`${cmd} ${args.join(" ")}\` was killed after ${Date.now() - started}ms; ${exited}\n` +
						`--- process group ${child.pid} at the timeout ---\n${group}\n${output()}`
				)
			);
		}, CHILD_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`\`${cmd} ${args.join(" ")}\` exited ${code ?? signal}\n${output()}`));
		});
	});
}
const WEB = new URL("../..", import.meta.url).pathname;

// CUR-1517 swapped `drizzle-kit migrate` for scripts/db-migrate.mjs in `vercel-build`, because
// drizzle-kit exits 1 on a failed migration without printing why. The wrapper calls the migrator
// drizzle-kit itself wraps, so the two are supposed to share migration state — same ./drizzle
// folder, same journal, same drizzle.__drizzle_migrations table.
//
// "Supposed to" is not the standard for something that mutates a database's schema. If they did NOT
// share state, the failure would be a migration re-applied on a database that already had it, and
// the symptom would surface as a confusing DDL error in a preview build rather than as anything
// naming this change. So this asserts the property directly, against a real database.
//
// WHAT THIS COVERS: the steady state, which is the one every preview build after the first is in —
// both commands run against an already-migrated database, both exit 0, and neither adds a row.
// WHAT IT DOES NOT: the fresh-apply comparison (both migrating an empty database to the same 32
// tables and the same 21 hashes in the same order). That needs CREATE DATABASE, which the CI
// database does not grant; it is checked by hand against two throwaway databases in a local
// container.
//
// Stateful project (serial): it reads and can in principle write the shared database, so running it
// file-parallel with the other DB specs is the CUR-93 race.

const MIGRATIONS = "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id";

const { url } = migrationDatabaseUrl();
const sql = postgres(url, { max: 1, onnotice: () => {} });

afterAll(async () => {
	await sql.end({ timeout: 5 }).catch(() => {});
});

const applied = async (): Promise<string[]> => (await sql.unsafe(MIGRATIONS)).map((r) => String(r.hash));

describe("db-migrate and drizzle-kit migrate share migration state, so either can follow the other", () => {
	it("leaves the applied set untouched when each runs in turn against an already-migrated database", async () => {
		const before = await applied();
		// A database with nothing recorded would make every assertion below vacuously true.
		expect(before.length).toBeGreaterThan(0);

		await run("node", ["scripts/db-migrate.mjs"]);
		const afterWrapper = await applied();
		expect(afterWrapper).toEqual(before);

		// Through the wrapper, not `npx drizzle-kit`: see scripts/drizzle-kit.sh for the Node 24 exit
		// hang it avoids (CUR-2010).
		await run("./scripts/drizzle-kit.sh", ["migrate"]);
		const afterKit = await applied();
		expect(afterKit).toEqual(before);
	}, 120_000);
});
