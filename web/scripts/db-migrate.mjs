#!/usr/bin/env node
// db-migrate — applies the Drizzle migrations and, unlike `drizzle-kit migrate`, says why when they
// fail (CUR-1517).
//
// `drizzle-kit migrate` 0.31.10 exits 1 on a failed migration and prints only its spinner. The
// message is not overwritten by the spinner's carriage returns — it is absent. On a forced connection
// failure: no ECONNREFUSED, no host, no port, nothing survives `tr '\r' '\n'`. `--verbose`, `--force`,
// `CI=true` and `NO_COLOR=1 TERM=dumb` each emit the same nothing.
//
// A preview whose migration fails never deploys, and scenario-suite-check.yml's wait-for-preview takes
// the first terminal status it sees for a ref as final — so the PR's only real-browser e2e run never
// happens, and the build log holds no reason for any of it.
//
// This runs the migrator drizzle-kit itself wraps: drizzle-orm's own, against the same ./drizzle
// folder, the same journal and the same __drizzle_migrations table, so either command can follow the
// other. That is asserted against a real database in scripts/__tests__/dbMigrateParity.spec.ts for
// the steady state every build after the first is in; the fresh-apply comparison needs CREATE
// DATABASE and was run by hand against two throwaway databases (CUR-1517). This writes
// schema, and "supposed to share state" is not the standard for that.
//
// NEVER PRINTS THE CONNECTION STRING. Build logs are readable by anyone with project access and the
// DSN carries credentials. The variable NAME is what a failure needs, and that is what gets printed.

import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { migrationDatabaseUrl } from "./lib/migrationDatabaseUrl.mjs";

const FOLDER = new URL("../drizzle/", import.meta.url).pathname;
const log = (msg) => console.log(`[db-migrate] ${msg}`);

const { url, from } = migrationDatabaseUrl();
if (!url) {
	console.error(
		`[db-migrate] no connection string: none of DATABASE_URL, POSTGRES_URL_NON_POOLING or POSTGRES_URL is set.`
	);
	process.exit(1);
}

let pending = "an unknown number of";
try {
	const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", `file://${FOLDER}`), "utf8"));
	pending = String(journal.entries?.length ?? 0);
} catch {
	// A journal we cannot read is not a reason to refuse to migrate — the migrator reads it itself
	// and will fail loudly if it is genuinely broken. This count is for the log line only.
}

log(`applying migrations from the journal's ${pending} entr${pending === "1" ? "y" : "ies"}, using ${from}`);

// max: 1 — migrations are serial DDL, and a single connection keeps the sequence unambiguous.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
	await migrate(drizzle(sql), { migrationsFolder: FOLDER });
	log(`done — the database is at the journal's head.`);
} catch (e) {
	console.error(`[db-migrate] MIGRATION FAILED (connection from ${from})`);
	describe(e);
	await sql.end({ timeout: 5 }).catch(() => {});
	process.exit(1);
}

/**
 * Print an error and everything under it.
 *
 * WALK `cause`, OR THIS SCRIPT REPRODUCES THE BUG IT EXISTS TO FIX. drizzle-orm wraps the driver's error in a
 * `DrizzleQueryError` whose own message names the failed SQL and nothing else — so a version of
 * this that printed only the top-level error reported `Failed query: CREATE SCHEMA IF NOT EXISTS
 * "drizzle"` for a refused connection, which says what was being attempted and not one word about
 * why it did not work. That is the same gap as drizzle-kit's, one layer up.
 *
 * Every scalar own property, never a curated list: a curated list is what drops the one field that
 * names the next failure. `stack` is excluded because it points into drizzle-orm's internals, and
 * `query` because the message already carries it.
 */
function describe(err, depth = 0) {
	const pad = `[db-migrate] ${"  ".repeat(depth + 1)}`;
	console.error(`${pad}${err instanceof Error ? err.message : String(err)}`);
	if (!err || typeof err !== "object") return;
	for (const [k, v] of Object.entries(err)) {
		if (k === "message" || k === "stack" || k === "query" || k === "cause" || v == null) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			console.error(`${pad}  ${k}: ${v}`);
		}
	}
	if (err.cause && depth < 5) {
		console.error(`${pad}caused by:`);
		describe(err.cause, depth + 1);
	}
}

await sql.end({ timeout: 5 });
