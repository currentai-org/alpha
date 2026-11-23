/**
 * Reads an Open WebUI SQLite database, read-only, into plain rows.
 *
 * @remarks
 * The revision and column check, the queries and the row mapping are shared with the Postgres reader
 * (sourceRows.ts). JSON columns arrive as text and are parsed there; a value that does not parse is
 * kept as null and counted by the caller as unreadable, never guessed at.
 */
import { DatabaseSync } from "node:sqlite";
import { UnsupportedSourceError } from "../../shared/openWebUiImport/sourceSchema";
import { checkSource, groupMessages, sourceQueries, toChat, toFile, toTag, toUser, type Row, type SourceData } from "./sourceRows";

export type { SourceChat, SourceData, SourceMessageRow } from "./sourceRows";

const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

// SQLite stores JSON as text and epoch seconds as integers already, so the columns are read as they are.
const QUERIES = sourceQueries({ json: (c) => c, epoch: (c) => c, table: (t) => t });

/** Opens `path` read-only and returns everything the importer needs, or throws UnsupportedSourceError. */
export function readOpenWebUiSqlite(path: string): SourceData {
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path, { readOnly: true });
	} catch (e) {
		throw new UnsupportedSourceError(`cannot open ${path} as a SQLite database: ${(e as Error).message}`);
	}
	try {
		let versions: Row[];
		try {
			versions = db.prepare("SELECT version_num FROM alembic_version").all() as Row[];
		} catch {
			throw new UnsupportedSourceError("not an Open WebUI database: no alembic_version table");
		}
		const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => text(r.name)));
		const columns = new Map<string, string[]>();
		for (const t of ["user", "chat", "chat_message", "file", "tag"]) {
			if (tables.has(t)) columns.set(t, (db.prepare(`PRAGMA table_info("${t}")`).all() as Row[]).map((r) => text(r.name)));
		}
		const revision = checkSource(
			versions.map((r) => text(r.version_num)),
			columns
		);
		const all = (sql: string) => db.prepare(sql).all() as Row[];
		return {
			revision,
			users: all(QUERIES.users).map(toUser),
			chats: all(QUERIES.chats).map(toChat),
			messageRows: columns.has("chat_message") ? groupMessages(all(QUERIES.messages)) : new Map(),
			files: columns.has("file") ? all(QUERIES.files).map(toFile) : [],
			tags: columns.has("tag") ? all(QUERIES.tags).map(toTag) : [],
		};
	} finally {
		db.close();
	}
}
