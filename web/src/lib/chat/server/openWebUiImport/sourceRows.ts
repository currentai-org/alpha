/**
 * What every Open WebUI source reader shares: the row types the importer reads,
 * the revision and column check, and the mapping from a raw row to those types.
 *
 * @remarks
 * Each reader (SQLite, Postgres) runs the same queries in its own dialect and hands the raw rows here,
 * with JSON columns as text and timestamps as numbers, so both produce identical {@link SourceData}
 * for identical rows. The idempotence keys and the parity report are built from that data, so they
 * cannot differ between the two either.
 */
import { assertKnownRevision, FILE_TABLE_COLUMNS, MESSAGE_TABLE_COLUMNS, REQUIRED_COLUMNS, TAG_TABLE_COLUMNS, UnsupportedSourceError } from "../../shared/openWebUiImport/sourceSchema";

export interface SourceUser {
	id: string;
	email: string;
	name: string;
	role: string;
	profileImageUrl: string | null;
	oauth: unknown;
	createdAt: number | null;
}

export interface SourceChat {
	id: string;
	userId: string;
	title: string;
	/** The chat's own JSON (`history.messages` and friends), or null when absent or unparseable. */
	blob: unknown;
	createdAt: number | null;
	updatedAt: number | null;
	archived: boolean;
	pinned: boolean;
	folderId: string | null;
	/** The ids of the chat's tags, from `chat.meta.tags`. */
	tags: string[];
}

/** One of a person's tags, as Open WebUI's `tag` table keeps it. */
export interface SourceTag {
	id: string;
	userId: string;
	name: string;
	meta: Record<string, unknown> | null;
}

export interface SourceMessageRow {
	/** The row id, `{chat_id}-{message_id}`. */
	id: string;
	chatId: string;
	role: string;
	parentId: string | null;
	content: unknown;
	modelId: string | null;
	createdAt: number | null;
	/** The ids of the uploaded files the message carried (its `files` column), in order. */
	fileIds: string[];
}

/** One uploaded file as Open WebUI recorded it. The bytes live wherever `path` points, not in the database. */
export interface SourceFile {
	id: string;
	userId: string;
	/** The name the person uploaded it under. */
	filename: string;
	/** Where the bytes are: a path under the install's uploads directory, or `s3://bucket/key`. */
	path: string | null;
	/** The text Open WebUI extracted from the file (`data.content`), when it holds any. */
	text: string | null;
	contentType: string | null;
	createdAt: number | null;
}

export interface SourceData {
	revision: string;
	users: SourceUser[];
	chats: SourceChat[];
	/** Message rows by chat id; a chat with no rows falls back to its JSON. */
	messageRows: Map<string, SourceMessageRow[]>;
	/** Uploaded files, oldest first. Empty when the database has no `file` table. */
	files: SourceFile[];
	/** Every person's tags. Empty when the database has no `tag` table. */
	tags: SourceTag[];
}

export type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null);

function parseJson(v: unknown): unknown {
	if (typeof v !== "string" || v === "") return null;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

function parseJsonOr(v: string): unknown {
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
}

/** The SELECTs every reader runs. `json(col)` renders a JSON column as text, `epoch(col)` a timestamp as a number. */
export function sourceQueries(d: { json: (col: string) => string; epoch: (col: string) => string; table: (name: string) => string }) {
	return {
		users: `SELECT id, email, name, role, profile_image_url, ${d.json("oauth")} AS oauth, ${d.epoch("created_at")} AS created_at FROM ${d.table("user")} ORDER BY created_at, id`,
		chats: `SELECT id, user_id, title, ${d.json("chat")} AS chat, ${d.epoch("created_at")} AS created_at, ${d.epoch("updated_at")} AS updated_at, archived, pinned, ${d.json("meta")} AS meta, folder_id FROM ${d.table("chat")} ORDER BY created_at, id`,
		messages: `SELECT id, chat_id, role, parent_id, ${d.json("content")} AS content, ${d.json("files")} AS files, model_id, ${d.epoch("created_at")} AS created_at FROM ${d.table("chat_message")} ORDER BY created_at, id`,
		files: `SELECT id, user_id, filename, path, ${d.json("data")} AS data, ${d.json("meta")} AS meta, ${d.epoch("created_at")} AS created_at FROM ${d.table("file")} ORDER BY created_at, id`,
		tags: `SELECT id, name, user_id, ${d.json("meta")} AS meta FROM ${d.table("tag")} ORDER BY user_id, id`,
	};
}

/**
 * Checks the revision and the columns, given each table's column list (absent when the table is), and
 * returns the revision. Throws UnsupportedSourceError naming what is wrong.
 */
export function checkSource(revisions: readonly string[], columns: ReadonlyMap<string, readonly string[]>): string {
	const revision = assertKnownRevision(revisions);
	const want = (table: string, wanted: readonly string[], required: boolean) => {
		const cols = columns.get(table);
		if (!cols) {
			if (required) throw new UnsupportedSourceError(`revision ${revision} should have a ${table} table and does not`);
			return;
		}
		const have = new Set(cols);
		const missing = wanted.filter((c) => !have.has(c));
		if (missing.length) {
			throw new UnsupportedSourceError(`revision ${revision} should have ${table}(${missing.join(", ")}) and does not`);
		}
	};
	for (const [table, wanted] of Object.entries(REQUIRED_COLUMNS)) want(table, wanted, true);
	want("chat_message", MESSAGE_TABLE_COLUMNS, false);
	want("file", FILE_TABLE_COLUMNS, false);
	want("tag", TAG_TABLE_COLUMNS, false);
	return revision;
}

export const toUser = (r: Row): SourceUser => ({
	id: text(r.id),
	email: text(r.email),
	name: text(r.name),
	role: text(r.role),
	profileImageUrl: textOrNull(r.profile_image_url),
	oauth: parseJson(r.oauth),
	createdAt: num(r.created_at),
});

export const toChat = (r: Row): SourceChat => ({
	id: text(r.id),
	userId: text(r.user_id),
	title: text(r.title),
	blob: parseJson(r.chat),
	createdAt: num(r.created_at),
	updatedAt: num(r.updated_at),
	archived: Boolean(r.archived),
	pinned: Boolean(r.pinned),
	folderId: textOrNull(r.folder_id),
	tags: tagIds((parseJson(r.meta) as { tags?: unknown } | null)?.tags),
});

/** A `meta.tags` list as tag ids: its non-empty strings, each once, in order. Anything else is no tags. */
export function tagIds(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return [...new Set(tags.filter((t): t is string => typeof t === "string" && t.trim() !== ""))];
}

export function toTag(r: Row): SourceTag {
	const meta = parseJson(r.meta);
	return {
		id: text(r.id),
		userId: text(r.user_id),
		name: text(r.name) || text(r.id),
		meta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
	};
}

/**
 * The ids of the uploads a message's `files` list names. An entry is an object whose `file.id` or `id`
 * is the id of a row in the `file` table; a bare string is taken as that id. Entries naming no file
 * (an inline image, a collection) yield nothing, and an id appears once.
 */
export function attachedFileIds(files: unknown): string[] {
	if (!Array.isArray(files)) return [];
	const ids = files.flatMap((entry): string[] => {
		if (typeof entry === "string") return entry ? [entry] : [];
		if (!entry || typeof entry !== "object") return [];
		const e = entry as { id?: unknown; file?: { id?: unknown } | null; type?: unknown };
		if (e.type === "collection" || e.type === "image") return [];
		const id = typeof e.file?.id === "string" && e.file.id ? e.file.id : e.id;
		return typeof id === "string" && id ? [id] : [];
	});
	return [...new Set(ids)];
}

const toMessageRow = (r: Row): SourceMessageRow => ({
	id: text(r.id),
	chatId: text(r.chat_id),
	role: text(r.role),
	parentId: textOrNull(r.parent_id),
	// A JSON column: a JSON-encoded string, a block list or null. Text that is not JSON is kept as it is.
	content: typeof r.content === "string" ? parseJsonOr(r.content) : r.content,
	modelId: textOrNull(r.model_id),
	createdAt: num(r.created_at),
	fileIds: attachedFileIds(typeof r.files === "string" ? parseJson(r.files) : r.files),
});

export function toFile(r: Row): SourceFile {
	const data = parseJson(r.data) as { content?: unknown } | null;
	const meta = parseJson(r.meta) as { name?: unknown; content_type?: unknown } | null;
	const content = typeof data?.content === "string" && data.content.trim() !== "" ? data.content : null;
	return {
		id: text(r.id),
		userId: text(r.user_id),
		filename: text(r.filename) || (typeof meta?.name === "string" ? meta.name : "") || text(r.id),
		path: textOrNull(r.path),
		text: content,
		contentType: typeof meta?.content_type === "string" ? meta.content_type : null,
		createdAt: num(r.created_at),
	};
}

/** Groups message rows by chat, keeping each chat's rows in the order they arrived. */
export function groupMessages(rows: Row[]): Map<string, SourceMessageRow[]> {
	const out = new Map<string, SourceMessageRow[]>();
	for (const r of rows) {
		const m = toMessageRow(r);
		const list = out.get(m.chatId) ?? [];
		list.push(m);
		out.set(m.chatId, list);
	}
	return out;
}
