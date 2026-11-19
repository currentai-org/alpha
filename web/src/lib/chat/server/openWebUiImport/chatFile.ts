/**
 * Open WebUI's chat file, written from Alpha's conversations: the JSON list its Settings → Data
 * Controls → Export chats writes and Import chats reads. readChatFile.ts reads the same file back into the importer.
 *
 * @remarks
 * The file is a bare list of `chat` rows as Open WebUI's API returns them (`ChatResponse`): the row's
 * columns (`title`, `created_at` and `updated_at` in epoch seconds, `pinned`, `archived`, `meta`,
 * `folder_id`) around the chat's own JSON, whose `history.messages` is the message tree keyed by id,
 * each message naming its `parentId` and `childrenIds`. Import keeps `chat`, `meta`, `pinned`,
 * `archived`, `folder_id` and both timestamps, and gives every chat a new id; `folder_id` is cleared
 * unless the importing account already has that folder. Shapes read from Open WebUI 0.12.0's
 * `backend/open_webui/models/chats.py` (`ChatImportForm`, `ChatResponse`) and
 * `src/lib/components/chat/Settings/DataControls.svelte`; no code is taken from either.
 *
 * The list has no header, so the version this file targets rides in each chat's `meta.alpha_export`,
 * a free-form object Open WebUI stores and returns unchanged. Alpha has no folders, so it writes
 * none. A chat's tags travel as Open WebUI keeps them, tag ids in `meta.tags`; Alpha's tag
 * ids follow Open WebUI's rule for them, so Open WebUI reads each back as the same tag. Every branch travels: `history.currentId` and the flat `messages` list name the branch
 * Alpha opens the conversation on, the newest message's.
 */
import type { Conversation } from "$lib/chat/types/Conversation";
import { CHAT_FILE_REVISION, KNOWN_REVISIONS } from "./sourceSchema";

interface ChatFileMessage {
	id: string;
	parentId: string | null;
	childrenIds: string[];
	role: "user" | "assistant";
	content: string;
	/** Epoch seconds, as Open WebUI's own messages carry it. */
	timestamp: number;
	/** The model an answer came from. */
	model?: string;
	/** The models a question was asked of. */
	models?: string[];
	done?: true;
}

/** Where a chat in the file came from, and which Open WebUI chat file it was written for. */
interface ChatFileStamp {
	from: "alpha";
	/** The Open WebUI release, e.g. "Open WebUI 0.12.0". */
	open_webui: string;
	/** Its database revision, one of the importer's known revisions. */
	revision: string;
	/** The Alpha conversation this chat was written from. */
	conversation_id: string;
}

export interface ChatFileEntry {
	id: string;
	user_id: string;
	title: string;
	chat: {
		id: string;
		title: string;
		models: string[];
		params: Record<string, never>;
		history: { messages: Record<string, ChatFileMessage>; currentId: string | null };
		/** The branch `currentId` ends, root first. */
		messages: ChatFileMessage[];
		tags: string[];
		/** Epoch milliseconds, as Open WebUI's own chats carry it. */
		timestamp: number;
		files: never[];
	};
	created_at: number;
	updated_at: number;
	share_id: null;
	archived: boolean;
	pinned: boolean;
	meta: { tags: string[]; alpha_export: ChatFileStamp };
	folder_id: null;
}

const seconds = (d: Date | string | undefined, fallback: number) => {
	const ms = d ? new Date(d).getTime() : NaN;
	return Math.floor((Number.isNaN(ms) ? fallback : ms) / 1000);
};

/** One Alpha conversation as an Open WebUI chat, every branch included. */
export function toOpenWebUiChat(conversation: Conversation, now: Date = new Date()): ChatFileEntry {
	const id = conversation._id.toString();
	const created = new Date(conversation.createdAt ?? now).getTime() || now.getTime();
	const kept = conversation.messages.filter((m) => m.from === "user" || m.from === "assistant");
	const keptIds = new Set(kept.map((m) => m.id));
	// The nearest kept ancestor: Alpha's tree starts at a system message, which Open WebUI's does not.
	const parentOf = (ancestors: string[] | undefined) => [...(ancestors ?? [])].reverse().find((a) => keptIds.has(a)) ?? null;

	const messages: Record<string, ChatFileMessage> = {};
	for (const m of kept) {
		const model = m.requestedModel ?? conversation.model;
		messages[m.id] = {
			id: m.id,
			parentId: parentOf(m.ancestors),
			childrenIds: [],
			role: m.from as "user" | "assistant",
			content: m.content,
			timestamp: seconds(m.createdAt, created),
			...(m.from === "assistant" ? { model, done: true as const } : { models: [model] }),
		};
	}
	// Children in the order Alpha stored them, which is the order they were written.
	for (const m of Object.values(messages)) if (m.parentId) messages[m.parentId].childrenIds.push(m.id);

	const leaf = kept.at(-1)?.id ?? null;
	const branch: ChatFileMessage[] = [];
	for (let at = leaf; at; at = messages[at].parentId) branch.unshift(messages[at]);

	const title = conversation.title || "New Chat";
	const stamp: ChatFileStamp = {
		from: "alpha",
		open_webui: KNOWN_REVISIONS[CHAT_FILE_REVISION],
		revision: CHAT_FILE_REVISION,
		conversation_id: id,
	};
	return {
		id,
		// Import ignores it and files the chat under whoever imports it; our account id stays out.
		user_id: "",
		title,
		chat: {
			id: "",
			title,
			models: [conversation.model],
			params: {},
			history: { messages, currentId: leaf },
			messages: branch,
			tags: [],
			timestamp: created,
			files: [],
		},
		created_at: Math.floor(created / 1000),
		updated_at: seconds(conversation.updatedAt, created),
		share_id: null,
		archived: Boolean(conversation.archived),
		pinned: Boolean(conversation.pinned),
		meta: { tags: [...(conversation.tags ?? [])], alpha_export: stamp },
		folder_id: null,
	};
}
