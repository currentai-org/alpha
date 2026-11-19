/**
 * The Open WebUI database revisions this importer has been checked against.
 *
 * @remarks
 * Open WebUI versions its database with Alembic, so the `alembic_version` table names the revision a
 * database is at. A revision is listed here only after its migrations were read for any change to the
 * `user`, `chat` and `chat_message` columns the reader selects. Every other revision is refused, and the
 * message names the one found, so a newer install fails loudly instead of being half-read.
 *
 * To add a version: read the migrations since the last listed revision, extend the reader and the
 * fixture if a column moved, then add the new head here.
 */
export const KNOWN_REVISIONS: Readonly<Record<string, string>> = {
	b8f2c6d91a04: "Open WebUI 0.12.0",
};

/**
 * The Open WebUI revision whose chat file (Settings → Data Controls → Import / Export chats) Alpha
 * writes and reads. Must be one of {@link KNOWN_REVISIONS}: the file is the `chat` row's
 * shape, so it moves when the table does.
 */
export const CHAT_FILE_REVISION = "b8f2c6d91a04";

/** The columns the reader selects, per table. A database missing one is refused whatever its revision. */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	user: ["id", "email", "name", "role", "profile_image_url", "oauth", "created_at"],
	chat: ["id", "user_id", "title", "chat", "created_at", "updated_at", "archived", "pinned", "meta", "folder_id"],
};

/** Present from the revision that added the table; read when it exists, and the chat's own JSON is used otherwise. */
export const MESSAGE_TABLE_COLUMNS = ["id", "chat_id", "role", "parent_id", "content", "files", "model_id", "created_at"] as const;

/** The `file` table's columns the file pass reads; checked when the table exists. */
export const FILE_TABLE_COLUMNS = ["id", "user_id", "filename", "path", "data", "meta", "created_at"] as const;

/** The `tag` table's columns: a person's tags, keyed (id, user_id). Checked when the table exists. */
export const TAG_TABLE_COLUMNS = ["id", "name", "user_id", "meta"] as const;

export class UnsupportedSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedSourceError";
	}
}

/** Throws UnsupportedSourceError unless `revisions` (the `alembic_version` rows) is exactly one known revision. */
export function assertKnownRevision(revisions: readonly string[]): string {
	if (revisions.length === 0) {
		throw new UnsupportedSourceError("not an Open WebUI database: alembic_version holds no revision");
	}
	if (revisions.length > 1) {
		throw new UnsupportedSourceError(`alembic_version holds ${revisions.length} revisions (${revisions.join(", ")}); expected one`);
	}
	const [found] = revisions;
	if (!(found in KNOWN_REVISIONS)) {
		const known = Object.entries(KNOWN_REVISIONS)
			.map(([rev, name]) => `${rev} (${name})`)
			.join(", ");
		throw new UnsupportedSourceError(`Open WebUI schema revision ${found} is not one this importer knows; known: ${known}`);
	}
	return found;
}
