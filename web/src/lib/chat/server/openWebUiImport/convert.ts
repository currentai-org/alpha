/**
 * Open WebUI chat to Alpha conversation, tree to tree. Pure: no database, no clock.
 *
 * @remarks
 * Both apps store a message tree. Alpha's conversation starts with an empty system root, and each
 * message lists its `ancestors` (root first) and its `children`. An Open WebUI message has one
 * `parentId`, and its `chat_message` rows (or, for a chat with none, the chat's own JSON) give the
 * rest. Ids are derived from the chat id and the message id so a rerun produces the same ids.
 *
 * Roles other than user and assistant are not imported: a system message in the history would read as
 * instructions to the model on the next turn. Their children move up to the nearest message that is
 * imported. A message whose parent is missing hangs off the root, and a message reachable from no root
 * (a cycle) is skipped with its reason. Nothing is dropped without a line in `skipped`.
 */
import { createHash } from "node:crypto";
import { v5 } from "uuid";
import type { Message, MessageFile } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import type { SourceChat, SourceMessageRow } from "./readSqlite";
import { attachedFileIds } from "./sourceRows";
import type { ImportedFile } from "./files";

/** A fixed namespace so one chat and message id always derive the same Alpha id. */
const ID_NAMESPACE = "6f1c2f1e-5f0b-4b8e-9a53-0a3c1d6f7b21";

export const IMPORT_ORIGIN = "open-webui-import";

interface SourceMessage {
	id: string;
	parentId: string | null;
	role: string;
	content: unknown;
	/** Milliseconds, or null when the source carried none. */
	createdAtMs: number | null;
	/** Ids of the uploaded files the message carried. */
	fileIds: string[];
}

export interface ConvertedConversation {
	sourceId: string;
	title: string;
	createdAt: Date;
	updatedAt: Date;
	/** Root first, then the imported messages in tree order. */
	messages: Message[];
	/** Hash of what the source holds for this chat, so a rerun can tell whether it changed. */
	fingerprint: string;
	sourceMessages: number;
	skipped: { messageId: string; reason: string }[];
	/** Content blocks that were not text and were left out of a message's text. */
	droppedBlocks: number;
	/** Files a message carried that it holds no reference to, with why. The message's text is imported either way. */
	attachmentSkips: { messageId: string; fileId: string; reason: string }[];
}

export type ConvertOutcome = { ok: true; value: ConvertedConversation } | { ok: false; reason: string };

/** Epoch seconds, milliseconds, microseconds or nanoseconds to milliseconds. */
export function epochToMs(n: number | null | undefined): number | null {
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
	if (n >= 1e17) return Math.floor(n / 1e6);
	if (n >= 1e14) return Math.floor(n / 1e3);
	if (n >= 1e11) return Math.floor(n);
	return Math.floor(n * 1000);
}

/** A message's text: a string as is, a block list as its text blocks joined; `dropped` counts the rest. */
export function flattenContent(content: unknown): { text: string; dropped: number } {
	if (typeof content === "string") return { text: content, dropped: 0 };
	if (!Array.isArray(content)) return { text: "", dropped: content == null ? 0 : 1 };
	const parts: string[] = [];
	let dropped = 0;
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		} else dropped += 1;
	}
	return { text: parts.join("\n\n"), dropped };
}

function fromRows(chatId: string, rows: SourceMessageRow[]): SourceMessage[] {
	const prefix = `${chatId}-`;
	return rows.map((r) => ({
		id: r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id,
		parentId: r.parentId,
		role: r.role,
		content: r.content,
		createdAtMs: epochToMs(r.createdAt),
		fileIds: r.fileIds,
	}));
}

/** The messages in the chat's own JSON (`history.messages`, a map by id), or null when it has none. */
function fromBlob(blob: unknown): SourceMessage[] | null {
	const map = (blob as { history?: { messages?: unknown } } | null)?.history?.messages;
	if (!map || typeof map !== "object" || Array.isArray(map)) return null;
	return Object.entries(map as Record<string, unknown>).flatMap(([key, raw]) => {
		if (!raw || typeof raw !== "object") return [];
		const m = raw as { id?: unknown; parentId?: unknown; role?: unknown; content?: unknown; timestamp?: unknown; files?: unknown };
		return [
			{
				id: typeof m.id === "string" && m.id ? m.id : key,
				parentId: typeof m.parentId === "string" && m.parentId ? m.parentId : null,
				role: typeof m.role === "string" ? m.role : "",
				content: m.content,
				createdAtMs: epochToMs(typeof m.timestamp === "number" ? m.timestamp : null),
				fileIds: attachedFileIds(m.files),
			},
		];
	});
}

const IMPORTED_ROLES = new Set(["user", "assistant"]);
const cleanTitle = (t: string) => t.replace(/<\/?think>/gi, "").trim().slice(0, 100) || "New Chat";

/** Converts one chat. Message rows win over the chat's JSON, the order Open WebUI itself reads them in. */
export function convertChat(
	chat: SourceChat,
	rows: SourceMessageRow[] | undefined,
	/** What the import made of each uploaded file, by Open WebUI file id. Absent: messages carry no file references. */
	files?: ReadonlyMap<string, ImportedFile>
): ConvertOutcome {
	const source = rows && rows.length ? fromRows(chat.id, rows) : fromBlob(chat.blob);
	if (!source) return { ok: false, reason: "the chat has no message rows and its JSON holds no history.messages" };

	const createdMs = epochToMs(chat.createdAt) ?? source.map((m) => m.createdAtMs).find((t) => t != null) ?? 0;
	const updatedMs = epochToMs(chat.updatedAt) ?? createdMs;
	const idOf = (messageId: string) => v5(`${chat.id}/${messageId}`, ID_NAMESPACE);
	const rootId = idOf("\u0000root");

	const byId = new Map(source.map((m, i) => [m.id, { ...m, order: i }]));
	const skipped: ConvertedConversation["skipped"] = [];
	const imported = new Map<string, (typeof source)[number] & { order: number }>();
	for (const [id, m] of byId) {
		if (IMPORTED_ROLES.has(m.role)) imported.set(id, m);
		else skipped.push({ messageId: id, reason: `role "${m.role}" is not imported` });
	}

	// The nearest imported ancestor, hopping over messages that are not imported; null attaches to the root.
	const parentOf = (id: string): string | null => {
		const seen = new Set([id]);
		let at = byId.get(id)?.parentId ?? null;
		while (at !== null) {
			if (seen.has(at)) return null;
			seen.add(at);
			if (imported.has(at)) return at;
			at = byId.get(at)?.parentId ?? null;
		}
		return null;
	};
	const kids = new Map<string | null, string[]>();
	for (const id of imported.keys()) {
		const p = parentOf(id);
		kids.set(p, [...(kids.get(p) ?? []), id]);
	}
	for (const list of kids.values()) {
		list.sort((a, b) => {
			const x = imported.get(a)!;
			const y = imported.get(b)!;
			return (x.createdAtMs ?? 0) - (y.createdAtMs ?? 0) || x.order - y.order;
		});
	}

	const root: Message = {
		id: rootId,
		from: "system",
		content: "",
		createdAt: new Date(createdMs),
		updatedAt: new Date(createdMs),
		children: (kids.get(null) ?? []).map(idOf),
		ancestors: [],
	};
	const messages: Message[] = [root];
	let droppedBlocks = 0;
	const attachmentSkips: ConvertedConversation["attachmentSkips"] = [];
	const stack: { id: string; ancestors: string[] }[] = [...(kids.get(null) ?? [])].reverse().map((id) => ({ id, ancestors: [rootId] }));
	const visited = new Set<string>();
	while (stack.length) {
		const { id, ancestors } = stack.pop()!;
		visited.add(id);
		const m = imported.get(id)!;
		const { text, dropped } = flattenContent(m.content);
		droppedBlocks += dropped;
		const at = new Date(m.createdAtMs ?? createdMs);
		const mine = idOf(id);
		const children = kids.get(id) ?? [];
		const refs: MessageFile[] = [];
		for (const fileId of files ? m.fileIds : []) {
			const made = files!.get(fileId);
			if (made?.ok) refs.push(made.ref);
			else attachmentSkips.push({ messageId: id, fileId, reason: made ? made.reason : "no file row in the source has this id" });
		}
		messages.push({
			id: mine,
			from: m.role as "user" | "assistant",
			content: text,
			createdAt: at,
			updatedAt: at,
			ancestors,
			children: children.map(idOf),
			...(refs.length ? { files: refs } : {}),
			// An imported answer arrives finished; without a final answer the page reads it as still generating.
			...(m.role === "assistant" ? { updates: [{ type: MessageUpdateType.FinalAnswer, text, interrupted: false }] } : {}),
		});
		for (const c of [...children].reverse()) stack.push({ id: c, ancestors: [...ancestors, mine] });
	}
	for (const id of imported.keys()) {
		if (!visited.has(id)) skipped.push({ messageId: id, reason: "not reachable from a root (its parents form a cycle)" });
	}

	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				title: chat.title,
				messages: source.map((m) => [m.id, m.parentId, m.role, m.content, m.createdAtMs]),
				// What each message references, so a rerun that can now attach a file updates the conversation.
				...(messages.some((m) => m.files?.length)
					? { attached: messages.filter((m) => m.files?.length).map((m) => [m.id, m.files!.map((f) => [f.value, f.location?.path])]) }
					: {}),
			})
		)
		.digest("hex");

	return {
		ok: true,
		value: {
			sourceId: chat.id,
			title: cleanTitle(chat.title),
			createdAt: new Date(createdMs),
			updatedAt: new Date(updatedMs),
			messages,
			fingerprint,
			sourceMessages: source.length,
			skipped,
			droppedBlocks,
			attachmentSkips,
		},
	};
}
