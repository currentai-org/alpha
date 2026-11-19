/**
 * Reads an Open WebUI chat file (chatFile.ts has its shape) into what the importer reads from a database.
 * Kept apart from the writer so the export route does not pull the importer's readers in.
 */
import { createHash } from "node:crypto";
import { assertKnownRevision, CHAT_FILE_REVISION, UnsupportedSourceError } from "./sourceSchema";
import { tagIds, type SourceChat, type SourceData, type SourceUser } from "./sourceRows";

/** The id the reader files every chat under: a chat file belongs to whoever exported it, and names nobody. */
export const CHAT_FILE_OWNER_ID = "chat-file-owner";

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Reads an Open WebUI chat file (Alpha's or Open WebUI's own) into what the importer reads from a
 * database, with every chat belonging to `owner`. Throws UnsupportedSourceError for a file that is not
 * a chat list, a ChatGPT export, or one stamped with a revision the importer does not know.
 */
export function readOpenWebUiChatFile(text: string, owner: { email: string; name?: string }): SourceData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UnsupportedSourceError("not an Open WebUI chat file: the file is not JSON");
	}
	if (!Array.isArray(parsed)) throw new UnsupportedSourceError("not an Open WebUI chat file: expected a JSON list of chats");
	const entries = parsed.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object");
	if (entries.some((e) => "mapping" in e)) {
		throw new UnsupportedSourceError("this is a ChatGPT export, not an Open WebUI chat file");
	}
	const stamped = new Set(
		entries.map((e) => str((e.meta as { alpha_export?: { revision?: unknown } } | undefined)?.alpha_export?.revision)).filter((r) => r !== null)
	);
	// A file Open WebUI wrote carries no version, and is read as the shape this code targets.
	const revision = stamped.size ? assertKnownRevision([...stamped]) : CHAT_FILE_REVISION;

	const user: SourceUser = {
		id: CHAT_FILE_OWNER_ID,
		email: owner.email,
		name: owner.name ?? "",
		role: "user",
		profileImageUrl: null,
		oauth: null,
		createdAt: null,
	};
	const chats: SourceChat[] = entries.map((e) => {
		// A list entry is a chat row around the chat's JSON; an old export held the JSON alone.
		const blob = e.chat && typeof e.chat === "object" ? (e.chat as Record<string, unknown>) : e;
		const id = str(e.id) ?? str(blob.id) ?? createHash("sha256").update(JSON.stringify(blob)).digest("hex").slice(0, 32);
		return {
			id,
			userId: CHAT_FILE_OWNER_ID,
			title: str(e.title) ?? str(blob.title) ?? "New Chat",
			blob,
			createdAt: num(e.created_at) ?? num(blob.timestamp),
			updatedAt: num(e.updated_at),
			archived: e.archived === true,
			pinned: e.pinned === true,
			folderId: str(e.folder_id),
			// The file carries tag ids only; the importer names each tag after its id.
			tags: tagIds((e.meta as { tags?: unknown } | undefined)?.tags),
		};
	});
	return { revision, users: [user], chats, messageRows: new Map(), files: [], tags: [] };
}
