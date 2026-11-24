/**
 * The Open WebUI database revisions this importer has been checked against.
 *
 * @remarks
 * Open WebUI versions its database with Alembic, so the `alembic_version` table names the revision a
 * database is at. A revision is listed here only after its migrations were read for any change to the
 * columns the reader selects from `user`, `chat`, `chat_message`, `file` and `tag`, and to the `auth`
 * and `folder` tables beside them. Every
 * other revision, a newer one included, is refused, and the message names the one found, so a newer
 * install fails loudly instead of being half-read.
 *
 * Each entry is the head a release ships, oldest first; the last one is the newest this importer knows.
 * The migrations from 0.12.0 to the 0.13.4 head add tables (apps, comments, notifications, auth
 * sessions, chat view state), a `tool` column and channel indexes, and backfill missing `auth` rows;
 * none touches a column the reader selects, so the reader and the fixture are the same for all four.
 *
 * To add a version: read the migrations since the last listed revision, extend the reader and the
 * fixture if a column moved, then add the new head at the end.
 */
const RELEASE_HEADS: readonly (readonly [revision: string, release: string])[] = [
	// Open WebUI 0.12.0.
	["b8f2c6d91a04", "Open WebUI 0.12.0"],
	// Open WebUI 0.12.1 through 0.12.5 share this head (add apps, then add missing auth rows).
	["0bd252b206fb", "Open WebUI 0.12.1-0.12.5"],
	// Open WebUI 0.13.0 (resource comments, tool is_active, notification inbox).
	["e42c8f710a36", "Open WebUI 0.13.0"],
	// Open WebUI 0.13.1 through 0.13.4 share this head (auth sessions, chat view state, channel indexes).
	["9f6c2a8d1b43", "Open WebUI 0.13.1-0.13.4"],
];

export const KNOWN_REVISIONS: Readonly<Record<string, string>> = Object.fromEntries(RELEASE_HEADS);

/**
 * The newest revision listed, named in the refusal so an operator can tell they are ahead of it. Taken
 * from the list rather than the record's keys, whose order an all-digit revision would change.
 */
const NEWEST_KNOWN_REVISION = RELEASE_HEADS[RELEASE_HEADS.length - 1][0];

/**
 * The Open WebUI revision whose chat file (Settings → Data Controls → Import / Export chats) Alpha
 * writes and reads. Must be one of {@link KNOWN_REVISIONS}: the file is the `chat` row's
 * shape, so it moves when the table does. It stays at 0.12.0: the `chat` table is unchanged through
 * the 0.13.4 head, so the file is the same for every listed release.
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
		throw new UnsupportedSourceError(
			`Open WebUI schema revision ${found} is not one this importer knows; the newest it knows is ${NEWEST_KNOWN_REVISION} (${KNOWN_REVISIONS[NEWEST_KNOWN_REVISION]}); known: ${known}`
		);
	}
	return found;
}
