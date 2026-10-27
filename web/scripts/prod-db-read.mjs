#!/usr/bin/env node
// Read the production chat database by hand, with a record of who read what and why (CUR-4385).
//
//   pnpm db:prod-read --reason "CUR-1234: which model served turn X" --sql "select ... limit 20"
//   pnpm db:prod-read --reason "..." --sql-file query.sql --csv
//
// Before psql runs, one event goes to the Axiom security dataset (CUR-4143): the actor (git email,
// agent identity, OS user, host), the reason, the query's shape, the tables it reads and the time.
// Nobody with database access can alter that dataset. When the event cannot be sent the query does
// not run.
//
// The event never carries the SQL text. A query that searches messages for a phrase would otherwise
// copy a person's own words into Axiom, which the privacy notice says receives no conversation
// content. It carries the normalized shape instead (every literal replaced with ?, comments dropped,
// the way pg_stat_statements shows a query) and a sha256 of the full text, so someone holding the
// query can still match it to its record.
//
// Only reads get through, twice over. Postgres's own parser (libpg-query) refuses anything but one
// SELECT, EXPLAIN without ANALYZE, or SHOW, and any write, row lock, SELECT INTO or side-effecting
// function inside it. The guarantee is the server's: psql runs with PGOPTIONS
// default_transaction_read_only=on and wraps the statement in BEGIN READ ONLY ... ROLLBACK, so
// Postgres rejects any write that gets past the parse check.
//
// What this does not do: stop someone running psql directly. It is the documented path, but a person
// holding production credentials can still go around it. Database-side auditing (pgaudit) is what would close that, and is left on CUR-4385.
//
// Env (read inside `doppler run --config prd`, never printed): DATABASE_URL, AXIOM_SECURITY_TOKEN,
// AXIOM_SECURITY_DATASET, AXIOM_INGEST_URL. PROD_DB_READ_AXIOM_URL overrides the ingest host, for the spec only.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { normalize, parse, scan } from "libpg-query";

const DOPPLER_PROJECT = "alpha-chat";
const DEFAULT_CONFIG = "prd";
const INNER_MARKER = "PROD_DB_READ_INNER";
const MIN_REASON = 10;
const MAX_SQL = 20_000;
const FORMAT_FLAGS = new Set(["--csv", "-x", "-A", "-t", "-q"]);
const SEND_TIMEOUT_MS = 10_000;

const USAGE = `Usage: pnpm db:prod-read --reason "<why>" --sql "<one read-only statement>" [--csv|-x|-A|-t|-q] [--config prd]
  --reason    Required. Name the ticket or report id and the question. Never quote the conversation.
  --sql       One SELECT, EXPLAIN (without ANALYZE) or SHOW. --sql-file <path> reads it from a file.
The read is recorded in the Axiom security dataset before it runs, and refused if that fails.`;

export class Refusal extends Error {
	/** @param {string} message @param {number} code */
	constructor(message, code = 2) {
		super(message);
		this.code = code;
	}
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	/** @type {{reason?: string, sql?: string, sqlFile?: string, config: string, format: string[]}} */
	const out = { config: DEFAULT_CONFIG, format: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Refusal(`${a} needs a value.`);
			return v;
		};
		if (a === "--reason") out.reason = next();
		else if (a === "--sql") out.sql = next();
		else if (a === "--sql-file") out.sqlFile = next();
		else if (a === "--config") out.config = next();
		else if (FORMAT_FLAGS.has(a)) out.format.push(a);
		else
			throw new Refusal(
				`Unknown argument ${JSON.stringify(a)}. Allowed: --reason, --sql, --sql-file, --config, ${[...FORMAT_FLAGS].join(" ")}.`
			);
	}
	const reason = (out.reason ?? "").replace(/\s+/g, " ").trim();
	if (reason.length < MIN_REASON) {
		throw new Refusal(`--reason is required (at least ${MIN_REASON} characters).\n${USAGE}`);
	}
	out.reason = reason;
	if (out.sql !== undefined && out.sqlFile !== undefined) throw new Refusal("Pass --sql or --sql-file, not both.");
	if (out.sqlFile !== undefined) out.sql = readFileSync(out.sqlFile, "utf8");
	if (!out.sql || !out.sql.trim()) throw new Refusal("--sql (or --sql-file) is required.");
	if (!/^[a-z][a-z0-9_]*$/.test(out.config))
		throw new Refusal(`--config ${JSON.stringify(out.config)} is not a Doppler config name.`);
	return out;
}

// Functions with side effects, refused wherever they appear in a read.
const FORBIDDEN_FUNCS = new Set([
	"set_config",
	"nextval",
	"setval",
	"pg_terminate_backend",
	"pg_cancel_backend",
	"pg_reload_conf",
	"pg_advisory_lock",
	"pg_advisory_xact_lock",
	"pg_try_advisory_lock",
	"dblink",
	"dblink_exec",
	"lo_import",
	"lo_export",
	"lo_unlink",
	"lo_create",
	"lo_put",
	"lo_from_bytea",
]);
const WRITE_NODES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

/** Every node in a parse tree, as [type, body] pairs. @param {unknown} node @param {Array<[string, any]>} out */
function walk(node, out = []) {
	if (Array.isArray(node)) for (const n of node) walk(n, out);
	else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) {
			if (/^[A-Z]/.test(k)) out.push([k, v]);
			walk(v, out);
		}
	}
	return out;
}

/**
 * Accept one read-only statement, or say why not. The parse is Postgres's own (libpg-query).
 * @param {string} sql
 * @returns {Promise<{ ok: true, sql: string, shape: string, tables: string[] } | { ok: false, why: string }>}
 */
export async function inspectSql(sql) {
	if (sql.length > MAX_SQL) return { ok: false, why: `the query is longer than ${MAX_SQL} characters` };
	// A psql meta-command (\! runs a shell) is not SQL, so the parse below refuses it; psql sends a
	// -c string that does not start with a backslash to the server unchanged.
	const text = sql.trim().replace(/;\s*$/, "");
	let tree;
	try {
		tree = await parse(text);
	} catch (e) {
		return { ok: false, why: `Postgres cannot parse it (${e instanceof Error ? e.message : String(e)})` };
	}
	const stmts = tree.stmts ?? [];
	if (stmts.length !== 1) return { ok: false, why: "only one statement per run" };
	const [[top, body]] = Object.entries(stmts[0].stmt);
	if (top === "ExplainStmt") {
		const opts = (body.options ?? []).map((/** @type {any} */ o) => o.DefElem?.defname);
		if (opts.includes("analyze")) return { ok: false, why: "EXPLAIN ANALYZE runs the statement" };
		if (!body.query?.SelectStmt) return { ok: false, why: "EXPLAIN is accepted only for a SELECT" };
	} else if (top !== "SelectStmt" && top !== "VariableShowStmt") {
		return { ok: false, why: `${top} is not a read; a read is SELECT, EXPLAIN or SHOW` };
	}
	const nodes = walk(stmts[0].stmt);
	const tables = new Set();
	for (const [type, n] of nodes) {
		if (WRITE_NODES.has(type)) return { ok: false, why: `it contains a ${type.replace("Stmt", "").toUpperCase()}` };
		if (type === "SelectStmt" && n.intoClause) return { ok: false, why: "SELECT INTO creates a table" };
		if (type === "SelectStmt" && n.lockingClause) return { ok: false, why: "FOR UPDATE/SHARE takes row locks" };
		if (type === "FuncCall") {
			const name = n.funcname?.at(-1)?.String?.sval;
			if (FORBIDDEN_FUNCS.has(name)) return { ok: false, why: `${name}() has side effects` };
		}
		if (type === "RangeVar") tables.add(n.schemaname ? `${n.schemaname}.${n.relname}` : n.relname);
	}
	return { ok: true, sql: text, shape: await shapeOf(text), tables: [...tables].sort() };
}

/** The query with every literal replaced by ? and comments dropped: safe to log, still readable. */
async function shapeOf(/** @type {string} */ sql) {
	const normalized = await normalize(sql);
	const { tokens } = await scan(normalized);
	return tokens
		.filter((/** @type {any} */ t) => t.tokenName !== "C_COMMENT" && t.tokenName !== "SQL_COMMENT")
		.map((/** @type {any} */ t) => (t.tokenName === "PARAM" ? "?" : t.text))
		.join(" ");
}

/** Who is running this. Derived, never typed, so a reader of the log can trust it as far as the
 *  machine's own git and agent-identity config go. @param {NodeJS.ProcessEnv} env */
export function actorOf(env) {
	let gitEmail = null;
	try {
		gitEmail =
			execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
			null;
	} catch {
		gitEmail = null;
	}
	let osUser = null;
	try {
		osUser = userInfo().username;
	} catch {
		osUser = env.USER ?? null;
	}
	return {
		gitEmail,
		pennonIdentity: env.PENNON_IDENTITY || null,
		agent: env.CLAUDECODE === "1",
		osUser,
		host: hostname(),
	};
}

/** The audit event. Never the SQL text: its shape, tables and hash only.
 * @param {{reason: string, sql: string, shape: string, tables: string[], config: string, actor: object, now?: Date}} p */
export function buildEvent({ reason, sql, shape, tables, config, actor, now = new Date() }) {
	return {
		_time: now.toISOString(),
		event: "staff.db_read",
		message: "[security] staff read the production database",
		config,
		actor,
		reason,
		queryShape: shape,
		tables,
		sqlSha256: createHash("sha256").update(sql).digest("hex"),
	};
}

/**
 * Send the event and resolve only when Axiom accepted it. Any other outcome throws a Refusal, and the
 * caller does not run the query.
 * @param {object} event @param {NodeJS.ProcessEnv} env @param {typeof fetch} fetchImpl
 */
export async function sendAuditEvent(event, env, fetchImpl = fetch) {
	const token = env.AXIOM_SECURITY_TOKEN;
	const dataset = env.AXIOM_SECURITY_DATASET;
	const missing = [!token && "AXIOM_SECURITY_TOKEN", !dataset && "AXIOM_SECURITY_DATASET"].filter(Boolean);
	if (missing.length)
		throw new Refusal(
			`Refusing to run: ${missing.join(" and ")} not set in this Doppler config, so the read cannot be recorded.`,
			3
		);
	// AXIOM_INGEST_URL names the dataset's edge when it is not the org's default (US) edge: api.axiom.co
	// refuses those with a 400, so they go through the edge's own ingest path (CUR-646).
	const host = env.PROD_DB_READ_AXIOM_URL || "https://api.axiom.co";
	const edge = String(env.AXIOM_INGEST_URL ?? "")
		.trim()
		.replace(/\/+$/, "");
	const name = encodeURIComponent(String(dataset));
	const url = edge ? `${edge}/v1/ingest/${name}` : `${host}/v1/datasets/${name}/ingest`;
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify([event]),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	} catch (e) {
		throw new Refusal(
			`Refusing to run: the audit event could not be sent (${e instanceof Error ? e.message : String(e)}).`,
			3
		);
	}
	if (!res.ok) throw new Refusal(`Refusing to run: Axiom answered ${res.status} to the audit event.`, 3);
	// Axiom answers 200 with a per-row count. A row it rejected was never recorded, so it counts as a failure.
	const body = await res.json().catch(() => null);
	if (!body || typeof body.ingested !== "number" || body.ingested < 1) {
		throw new Refusal(
			`Refusing to run: Axiom did not confirm the audit event was ingested (${JSON.stringify(body)?.slice(0, 200)}).`,
			3
		);
	}
}

/** psql argv and env for one read-only statement. Exported for the spec. @param {string} sql @param {string[]} format @param {NodeJS.ProcessEnv} env */
export function psqlInvocation(sql, format, env) {
	return {
		args: [
			"--no-psqlrc",
			"-q",
			"-v",
			"ON_ERROR_STOP=1",
			...format,
			"-c",
			"BEGIN TRANSACTION READ ONLY",
			"-c",
			sql,
			"-c",
			"ROLLBACK",
			String(env.DATABASE_URL),
		],
		env: { ...env, PGOPTIONS: `${env.PGOPTIONS ? `${env.PGOPTIONS} ` : ""}-c default_transaction_read_only=on` },
	};
}

/**
 * The part that runs inside Doppler: validate again, record, then read. Returns psql's exit code.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, runPsql?: (args: string[], env: NodeJS.ProcessEnv) => Promise<number> }} deps
 */
export async function runInner(argv, deps = {}) {
	const env = deps.env ?? process.env;
	const opts = parseArgs(argv);
	const check = await inspectSql(String(opts.sql));
	if (!check.ok) throw new Refusal(`Refusing to run: ${check.why}. This wrapper only reads.`);
	if (!env.DATABASE_URL) throw new Refusal("Refusing to run: DATABASE_URL is not set (run through Doppler).", 3);
	const event = buildEvent({
		reason: String(opts.reason),
		sql: check.sql,
		shape: check.shape,
		tables: check.tables,
		config: opts.config,
		actor: actorOf(env),
	});
	await sendAuditEvent(event, env, deps.fetchImpl);
	const { args, env: psqlEnv } = psqlInvocation(check.sql, opts.format, env);
	const run = deps.runPsql ?? spawnPsql;
	return run(args, psqlEnv);
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
function spawnPsql(args, env) {
	return new Promise((resolve) => {
		const child = spawn("psql", args, { env, stdio: "inherit" });
		child.on("error", (e) => {
			process.stderr.write(`prod-db-read: could not start psql: ${e.message}\n`);
			resolve(127);
		});
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

/** Outside Doppler: check what can be checked without secrets, then re-run inside `doppler run`. */
async function main(argv) {
	if (process.env[INNER_MARKER]) return runInner(argv);
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const opts = parseArgs(argv);
	const check = await inspectSql(String(opts.sql));
	if (!check.ok) throw new Refusal(`Refusing to run: ${check.why}. This wrapper only reads.`);
	const self = fileURLToPath(import.meta.url);
	return new Promise((resolve) => {
		const child = spawn(
			"doppler",
			["run", "--project", DOPPLER_PROJECT, "--config", opts.config, "--", process.execPath, self, ...argv],
			{ env: { ...process.env, [INNER_MARKER]: "1" }, stdio: "inherit" }
		);
		child.on("error", (e) => {
			process.stderr.write(`prod-db-read: could not start doppler: ${e.message}\n`);
			resolve(127);
		});
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			process.stderr.write(`prod-db-read: ${e instanceof Error ? e.message : String(e)}\n`);
			process.exit(e instanceof Refusal ? e.code : 1);
		}
	);
}
