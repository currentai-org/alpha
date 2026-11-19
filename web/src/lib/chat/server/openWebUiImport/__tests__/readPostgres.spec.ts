/**
 * The Postgres source reader, against real Postgres. The synthetic 0.12.0 fixture is built
 * in SQLite (owuiFixture.ts), copied table by table into its own schema with the column types an Open
 * WebUI install on Postgres has (JSON as json, timestamps as bigint, flags as boolean), and read back
 * by both readers. The two must agree row for row, which is what lets the idempotence keys and the
 * parity report be shared.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";
import { readOpenWebUiPostgres, normalizePostgresUrl } from "../readPostgres";
import { readOpenWebUiSqlite } from "../readSqlite";
import { UnsupportedSourceError } from "../sourceSchema";
import { buildFixture, PG_COLUMN_TYPES as PG_TYPES } from "./owuiFixture";

const url = process.env.DATABASE_URL!;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
let sql: postgres.Sql;
let dir: string;
let dbPath: string;
let schema: string;

/** Copies every fixture table from the SQLite file into `schema`, with Open WebUI's Postgres column types. */
async function copyToPostgres(path: string, into: string, tables = Object.keys(PG_TYPES)) {
	const lite = new DatabaseSync(path, { readOnly: true });
	try {
		await sql.unsafe(`CREATE SCHEMA ${q(into)}`);
		for (const table of tables) {
			const cols = Object.entries(PG_TYPES[table]);
			await sql.unsafe(`CREATE TABLE ${q(into)}.${q(table)} (${cols.map(([c, t]) => `${q(c)} ${t}`).join(", ")})`);
			const insert = `INSERT INTO ${q(into)}.${q(table)} (${cols.map(([c]) => q(c)).join(", ")}) VALUES (${cols.map(([, t], i) => `$${i + 1}::text::${t}`).join(", ")})`;
			for (const row of lite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]) {
				await sql.unsafe(
					insert,
					cols.map(([c]) => (row[c] == null ? null : String(row[c])))
				);
			}
		}
	} finally {
		lite.close();
	}
}

beforeAll(() => {
	sql = postgres(normalizePostgresUrl(url), { max: 1, onnotice: () => {} });
});
afterAll(async () => {
	await sql.end({ timeout: 5 });
});
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owui-pg-"));
	dbPath = join(dir, "webui.db");
	schema = `owui_src_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
});
afterEach(async () => {
	rmSync(dir, { recursive: true, force: true });
	await sql.unsafe(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
});

describe.sequential("Open WebUI Postgres reader", () => {
	it("reads the same users, chats, message rows and files from Postgres as the SQLite reader reads from the same rows", async () => {
		buildFixture(dbPath).close();
		await copyToPostgres(dbPath, schema);

		const fromPg = await readOpenWebUiPostgres(url, { schema });
		const fromSqlite = readOpenWebUiSqlite(dbPath);
		expect(fromPg).toEqual(fromSqlite);
		// Not equal by both being empty: the fixture's branches, JSON-only chat and files all came across.
		expect(fromPg.chats).toHaveLength(6);
		expect(fromPg.messageRows.get("chat-a1")).toHaveLength(7);
		expect(fromPg.files).toHaveLength(4);
		expect(fromPg.users[0].oauth).toEqual({ oidc: { sub: "sub-alice-001" } });
	});

	it("refuses a Postgres database at an unknown Open WebUI revision and names the revision found", async () => {
		buildFixture(dbPath, "deadbeef0000").close();
		await copyToPostgres(dbPath, schema);

		const read = readOpenWebUiPostgres(url, { schema });
		await expect(read).rejects.toBeInstanceOf(UnsupportedSourceError);
		await expect(readOpenWebUiPostgres(url, { schema })).rejects.toThrow(/deadbeef0000/);
	});

	it("refuses a Postgres schema with no alembic_version table, such as Alpha's own, naming the schema", async () => {
		await sql.unsafe(`CREATE SCHEMA ${q(schema)}`);
		await expect(readOpenWebUiPostgres(url, { schema })).rejects.toThrow(new RegExp(`no alembic_version table in schema ${schema}`));
	});

	it("refuses a known revision whose chat table lost a column the reader selects", async () => {
		buildFixture(dbPath).close();
		await copyToPostgres(dbPath, schema);
		await sql.unsafe(`ALTER TABLE ${q(schema)}."chat" DROP COLUMN "title"`);
		await expect(readOpenWebUiPostgres(url, { schema })).rejects.toThrow(/chat\(title\)/);
	});

	it("accepts the URL forms Open WebUI's DATABASE_URL takes (postgresql+psycopg2:// included)", () => {
		expect(normalizePostgresUrl("postgresql+psycopg2://u:p@h:5432/db")).toBe("postgres://u:p@h:5432/db");
		expect(normalizePostgresUrl("postgresql://u:p@h/db")).toBe("postgres://u:p@h/db");
	});
});
