// The account page's downloads, with sealed conversations written in by the browser.
//
// The export routes build every file as before, but they cannot read a sealed message or title, so a
// sealed conversation comes out of them with empty text. The page fetches the file, fetches the sealed
// conversations as stored (`api/v2/export/sealed`), opens them here with the person's history key, and
// writes their text into the file before saving it. What it writes comes from the same builders the
// server uses (exportFormat.ts, chatFile.ts), so a sealed conversation reads in the file exactly as a
// plaintext one does. Nothing opened is sent anywhere.
//
// A conversation that does not open (this browser is locked, or a blob is damaged) fails the whole
// download with a reason, rather than saving a file that silently leaves its words out.

import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import superjson from "superjson";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import {
	conversationMarkdown,
	exportedConversation,
	type ExportedConversation,
	type ExportEnvelope,
} from "$lib/chat/shared/exportFormat";
import { toOpenWebUiChat, type ChatFileEntry } from "$lib/chat/shared/openWebUiImport/chatFile";
import type { ThunderboltEnvelope } from "$lib/chat/server/thunderboltExport";
import { inertWidgets } from "$lib/chat/utils/inertWidgets";
import { showsClosedSealedParts, type SealableConversation } from "$lib/chat/crypto/sealedShape";

/** One sealed conversation as `api/v2/export/sealed` returns it. */
export type StoredSealedConversation = SealableConversation & {
	id: string;
	title: string;
	model: string;
	createdAt?: Date | string;
	updatedAt?: Date | string;
};

/** A sealed conversation opened in this browser, in the shape the export builders read. */
export type OpenedForExport = Pick<Conversation, "_id" | "title" | "model" | "createdAt" | "updatedAt"> & {
	messages: Message[];
};

export type ExportKind = "zip" | "open-webui" | "thunderbolt";

/** Why a download with sealed conversations was refused, said on the account page. */
export class SealedExportError extends Error {
	override name = "SealedExportError";
	constructor(
		readonly reason: "locked" | "unreadable" | "download",
		message: string
	) {
		super(message);
	}
}

const asDate = (d: Date | string | undefined) => (d ? new Date(d) : new Date(0));

/**
 * Open every stored sealed conversation with `identity`, or refuse: a locked browser, or any part that
 * does not open, fails the export rather than writing a file without those words.
 */
export async function openForExport(
	stored: StoredSealedConversation[],
	identity: string | null,
	open: (doc: StoredSealedConversation, identity: string) => Promise<SealableConversation & { titleState?: unknown }> = async (doc, id) =>
		(await import("$lib/chat/crypto/sealedHistory")).openConversationDoc(doc, doc.id, id)
): Promise<OpenedForExport[]> {
	if (!stored.length) return [];
	if (!identity) {
		throw new SealedExportError(
			"locked",
			"Some of your chats are sealed with your history key. Unlock your history in this browser, then download again."
		);
	}
	const opened: OpenedForExport[] = [];
	let closed = 0;
	for (const doc of stored) {
		const view = await open(doc, identity);
		if (showsClosedSealedParts(view as Parameters<typeof showsClosedSealedParts>[0])) {
			closed++;
			continue;
		}
		opened.push({
			_id: doc.id as unknown as Conversation["_id"],
			title: view.title ?? "",
			model: doc.model,
			createdAt: asDate(doc.createdAt),
			updatedAt: asDate(doc.updatedAt),
			messages: view.messages,
		});
	}
	if (closed) {
		throw new SealedExportError(
			"unreadable",
			`${closed === 1 ? "One sealed chat" : `${closed} sealed chats`} could not be opened with this browser's key, so nothing was downloaded.`
		);
	}
	return opened;
}

/** Each message's file paths in the ZIP, as the server's entry for the conversation named them. */
function filesFrom(entry: ExportedConversation | undefined): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const m of entry?.messages ?? []) if (m.files?.length) out.set(m.id, m.files);
	return out;
}

/**
 * The ZIP with each opened conversation written in: its readable markdown replaces the server's (whose
 * name came from the empty sealed title), and its entry in conversations.json is rebuilt from the
 * opened text, keeping the tags and file paths the server wrote.
 */
export function patchExportZip(zip: Uint8Array, opened: OpenedForExport[]): Uint8Array {
	if (!opened.length) return zip;
	const files = unzipSync(zip);
	const jsonBytes = files["conversations.json"];
	if (!jsonBytes) throw new SealedExportError("download", "The export had no conversations.json to write sealed chats into.");
	const envelope = JSON.parse(strFromU8(jsonBytes)) as ExportEnvelope;
	for (const conv of opened) {
		const id = String(conv._id);
		const at = envelope.conversations.findIndex((c) => c.id === id);
		const before = at >= 0 ? envelope.conversations[at] : undefined;
		const byMessage = filesFrom(before);
		const entry = exportedConversation(conv as Conversation, byMessage);
		if (before?.tags) entry.tags = before.tags;
		if (before && before.readable !== entry.readable) delete files[before.readable];
		files[entry.readable] = strToU8(conversationMarkdown(conv as Conversation, byMessage));
		if (at >= 0) envelope.conversations[at] = entry;
		else envelope.conversations.push(entry);
	}
	files["conversations.json"] = strToU8(JSON.stringify(envelope, null, 2));
	return zipSync(files);
}

/** Open WebUI's chat file with each opened conversation rebuilt, keeping the archive, pin and tags the
 *  server wrote. */
export function patchOpenWebUiFile(chats: ChatFileEntry[], opened: OpenedForExport[], now = new Date()): ChatFileEntry[] {
	const byId = new Map(opened.map((c) => [String(c._id), c]));
	return chats.map((before) => {
		const conv = byId.get(before.id);
		if (!conv) return before;
		const after = toOpenWebUiChat(conv as Conversation, now);
		return {
			...after,
			archived: before.archived,
			pinned: before.pinned,
			created_at: before.created_at,
			updated_at: before.updated_at,
			chat: { ...after.chat, tags: before.chat.tags, timestamp: before.chat.timestamp },
			meta: { ...after.meta, tags: before.meta.tags },
		};
	});
}

/** Thunderbolt's file with each opened conversation's text, sources and title written into the rows
 *  the server minted for it (the ids stay, so a second import still updates in place). */
export function patchThunderboltFile(envelope: ThunderboltEnvelope, opened: OpenedForExport[]): ThunderboltEnvelope {
	const exported = new Map(opened.map((c) => [String(c._id), exportedConversation(c as Conversation)]));
	const titles = new Map<string, string | null>();
	const rows = envelope.tables.chat_messages.map((row) => {
		const alpha = row.metadata?.alpha as { conversationId?: string; messageId?: string } | undefined;
		const conv = alpha?.conversationId ? exported.get(alpha.conversationId) : undefined;
		const m = conv?.messages.find((x) => x.id === alpha?.messageId);
		if (!conv || !m) return row;
		titles.set(row.chatThreadId, conv.title || null);
		const text = inertWidgets(m.content);
		const { sources: _drop, ...meta } = row.metadata ?? {};
		return {
			...row,
			content: text,
			parts: [{ type: "text", text }],
			metadata: {
				...meta,
				...(m.sources?.length ? { sources: m.sources.map((s, i) => ({ index: i + 1, url: s.url, title: s.title })) } : {}),
				alpha: {
					...alpha,
					...(m.provenance ? { provenance: m.provenance } : {}),
					...(m.moderation ? { moderation: m.moderation } : {}),
				},
			},
		};
	});
	const threads = envelope.tables.chat_threads.map((t) => (titles.has(t.id) ? { ...t, title: titles.get(t.id) ?? null } : t));
	return { ...envelope, tables: { ...envelope.tables, chat_threads: threads, chat_messages: rows } };
}

function filenameOf(res: Response, fallback: string): string {
	const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
	return named ?? fallback;
}

async function failure(res: Response): Promise<SealedExportError> {
	const body = (await res.json().catch(() => null)) as { message?: string } | null;
	return new SealedExportError("download", body?.message ?? `The download failed (${res.status}). Please try again.`);
}

/**
 * Download one export with this account's sealed conversations written in. Fetches the sealed
 * conversations first, so a locked browser is refused before the export's rate window is spent.
 */
export async function buildSealedExport(
	kind: ExportKind,
	href: string,
	sealedHref: string,
	identity: string | null
): Promise<{ blob: Blob; filename: string }> {
	const sealedRes = await fetch(sealedHref);
	if (!sealedRes.ok) throw await failure(sealedRes);
	const { conversations } = superjson.parse<{ conversations: StoredSealedConversation[] }>(await sealedRes.text());
	const opened = await openForExport(conversations, identity);

	const res = await fetch(href);
	if (!res.ok) throw await failure(res);
	if (kind === "zip") {
		const zip = patchExportZip(new Uint8Array(await res.arrayBuffer()), opened);
		return { blob: new Blob([zip as BlobPart], { type: "application/zip" }), filename: filenameOf(res, "aipotluck-export.zip") };
	}
	const body = await res.json();
	const patched =
		kind === "open-webui"
			? patchOpenWebUiFile(body as ChatFileEntry[], opened)
			: patchThunderboltFile(body as ThunderboltEnvelope, opened);
	return {
		blob: new Blob([JSON.stringify(patched)], { type: "application/json" }),
		filename: filenameOf(res, kind === "open-webui" ? "chat-export.json" : "thunderbolt-export.json"),
	};
}
