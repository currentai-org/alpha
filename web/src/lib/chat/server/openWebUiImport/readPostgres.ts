/**
 * Reads an Open WebUI install that keeps its data in Postgres (its `DATABASE_URL`), read-only, into the
 * same rows the SQLite reader produces.
 *
 * @remarks
 * The revision and column check, the queries and the row mapping are the SQLite reader's
 * (sourceRows.ts). Only the dialect differs: JSON columns are cast to text and epoch-second
 * timestamps to numbers in the query, so the shared mapping sees exactly what SQLite hands it.
 * Everything runs inside one READ ONLY transaction, so the reader cannot change the source even by
 * mistake. `schema` is Open WebUI's `DATABASE_SCHEMA`; without it the connection's own search path
 * decides, as it does for Open WebUI.
 */
import postgres from "postgres";
import { UnsupportedSourceError } from "../../shared/openWebUiImport/sourceSchema";
import { checkSource, groupMessages, sourceQueries, toChat, toFile, toTag, toUser, type Row, type SourceData } from "./sourceRows";

const TABLES = ["user", "chat", "chat_message", "file", "tag"] as const;

/** True when `source` names a Postgres database rather than a file. */
export const isPostgresUrl = (source: string): boolean => /^postgres(ql)?(\+[a-z0-9_]+)?:\/\//i.test(source);

/** Open WebUI's URL as SQLAlchemy reads it (`postgresql+psycopg2://…` included), as the Postgres driver reads it. */
export function normalizePostgresUrl(url: string): string {
	return url.replace(/^postgres(ql)?(\+[a-z0-9_]+)?:\/\//i, "postgres://");
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Reads the install at `url` and returns everything the importer needs, or throws UnsupportedSourceError. */
export async function readOpenWebUiPostgres(url: string, opts: { schema?: string } = {}): Promise<SourceData> {
	if (!isPostgresUrl(url)) throw new UnsupportedSourceError("not a Postgres URL (expected postgres:// or postgresql://)");
	const sql = postgres(normalizePostgresUrl(url), { max: 1, onnotice: () => {}, connect_timeout: 15 });
	try {
		return await sql.begin("read only", async (tx) => {
			const [{ schema }] = opts.schema
				? [{ schema: opts.schema }]
				: ((await tx.unsafe("SELECT current_schema() AS schema")) as unknown as { schema: string }[]);
			if (!schema) throw new UnsupportedSourceError("the connection has no current schema; pass the one Open WebUI uses");
			const table = (t: string) => `${quoteIdent(schema)}.${quoteIdent(t)}`;

			let versions: Row[];
			try {
				versions = (await tx.unsafe(`SELECT version_num FROM ${table("alembic_version")}`)) as unknown as Row[];
			} catch (e) {
				if ((e as { code?: string }).code === "42P01") {
					throw new UnsupportedSourceError(`not an Open WebUI database: no alembic_version table in schema ${schema}`);
				}
				throw e;
			}
			const columnRows = await tx<{ table_name: string; column_name: string }[]>`
				SELECT table_name, column_name FROM information_schema.columns
				WHERE table_schema = ${schema} AND table_name IN ${tx([...TABLES])}
				ORDER BY ordinal_position`;
			const columns = new Map<string, string[]>();
			for (const r of columnRows) columns.set(r.table_name, [...(columns.get(r.table_name) ?? []), r.column_name]);

			const revision = checkSource(
				versions.map((r) => String(r.version_num ?? "")),
				columns
			);
			const queries = sourceQueries({
				json: (c) => `${quoteIdent(c)}::text`,
				epoch: (c) => `${quoteIdent(c)}::float8`,
				table,
			});
			const all = async (q: string) => (await tx.unsafe(q)) as unknown as Row[];
			return {
				revision,
				users: (await all(queries.users)).map(toUser),
				chats: (await all(queries.chats)).map(toChat),
				messageRows: columns.has("chat_message") ? groupMessages(await all(queries.messages)) : new Map(),
				files: columns.has("file") ? (await all(queries.files)).map(toFile) : [],
				tags: columns.has("tag") ? (await all(queries.tags)).map(toTag) : [],
			};
		});
	} catch (e) {
		if (e instanceof UnsupportedSourceError) throw e;
		const code = (e as { code?: string }).code;
		// A connection that never opened is a refused source, not a crash: the operator mistyped a URL.
		if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "28P01" || code === "3D000" || code === "CONNECT_TIMEOUT") {
			throw new UnsupportedSourceError(`cannot read the Postgres source: ${(e as Error).message}`);
		}
		throw e;
	} finally {
		await sql.end({ timeout: 5 });
	}
}
