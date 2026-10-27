import { createHash } from "node:crypto";
import type { ExportedConversation } from "$lib/chat/server/exportFormat";

// Converts Alpha's conversations.json into a file Thunderbird's Thunderbolt can import, and reads one
// of their exports back (CUR-2407). Thunderbolt's Settings → Preferences → Data → Import Data reads
// `thunderbolt-export` schemaVersion 1 (their docs/internals/architecture/export-format.md) and writes
// each row into the person's local database, which then syncs it, encrypted, to their other devices.
// The file itself is plaintext on both sides, the same as Alpha's ZIP.
//
// Three things in Thunderbolt's schema decide the mapping:
// - Neither chat_threads nor chat_messages has a created-at column. Both sort by id, a UUIDv7 whose
//   first 48 bits are milliseconds, so the id has to carry the time. Alpha's ids are ObjectIds and
//   random UUIDs, which would sort a thread out of order, so every row gets a UUIDv7 minted from its
//   createdAt, with the rest of the bits hashed from the Alpha id so a second export of the same
//   conversation produces the same ids and Thunderbolt's import updates them in place.
// - A thread renders every message whose deletedAt is null, flat, in id order. Alpha keeps every
//   branch a regenerate or an edit made, so only the branch the person last saw stays live and the
//   others travel soft-deleted: they render nowhere and still come back on the way home.
// - A message renders from `parts`; `content` is only the search copy. Metadata is free JSON, so
//   what Thunderbolt has no column for (provenance, served-by, the Alpha ids) rides under `alpha`.

const THUNDERBOLT_FORMAT = "thunderbolt-export";
const THUNDERBOLT_SCHEMA_VERSION = 1;

type TextPart = { type: "text"; text: string };

type ThunderboltThread = { id: string; title: string | null; deletedAt: string | null; userId: string | null };

type ThunderboltMessage = {
	id: string;
	content: string | null;
	role: "user" | "assistant" | "system";
	parts: ({ type: string } & Record<string, unknown>)[] | null;
	chatThreadId: string;
	modelId: string | null;
	parentId: string | null;
	cache: unknown;
	metadata: Record<string, unknown> | null;
	deletedAt: string | null;
	userId: string | null;
};

export type ThunderboltEnvelope = {
	format: typeof THUNDERBOLT_FORMAT;
	schemaVersion: typeof THUNDERBOLT_SCHEMA_VERSION;
	exportedAt: string;
	user: { id: string; email: string | null };
	tables: { chat_threads: ThunderboltThread[]; chat_messages: ThunderboltMessage[] } & Record<string, unknown[]>;
};

/** What rides in a message's metadata so the trip back to Alpha loses nothing Alpha wrote. */
type AlphaMetadata = {
	conversationId: string;
	messageId: string;
	/** Alpha's own parent id, kept whole: a first question's parent is the system prompt, which no export carries. */
	parentId?: string;
	digitalSourceType?: string;
	model?: string;
	createdAt?: string;
	provenance?: string;
	servedBy?: { model?: string; backend?: string };
	aiGenerated?: true;
	interrupted?: boolean;
	moderation?: { flagged: boolean; kind?: string };
	files?: string[];
	conversationCreatedAt?: string;
	conversationUpdatedAt?: string;
};

/** A UUIDv7 for `ms`, its other 74 bits taken from a hash of `seed`, so the same row maps the same way. */
export function uuidv7At(ms: number, seed: string): string {
	const hash = createHash("sha256").update(seed).digest();
	const bytes = Buffer.alloc(16);
	bytes.writeUIntBE(Math.max(0, Math.floor(ms)), 0, 6);
	hash.copy(bytes, 6, 0, 10);
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The time a UUIDv7 carries, as Thunderbolt reads it back (their src/lib/utils.ts uuidv7ToDate). */
export function uuidv7Time(id: string): Date | null {
	const hex = id.replace(/-/g, "");
	if (hex.length !== 32 || hex[12] !== "7") return null;
	return new Date(parseInt(hex.slice(0, 12), 16));
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

// Thunderbolt renders `<widget:NAME …>` in a message's text as live UI (their src/ai/widget-parser.ts):
// a "connect Gmail" OAuth prompt, a link preview that fetches a URL, a question whose answer goes back
// to the model. In Alpha the same text is inert, and an answer can carry it from a web page or a
// forked shared conversation. Escaping the `<` keeps it visible as text in Thunderbolt's markdown and
// out of their parser; the trip home restores it on rows Alpha wrote.
const inertWidgets = (text: string) => text.replace(/<(?=widget:)/gi, "&lt;");
const reviveWidgets = (text: string) => text.replace(/&lt;(?=widget:)/gi, "<");

/**
 * The branch Alpha opens a conversation on: the newest message and its ancestors. A branch someone
 * switched back to is kept only in that tab's sessionStorage (conversation/[id]/+page.svelte,
 * `leafKey`), so the server has nothing better to go on; every other branch still travels, soft-deleted.
 */
function displayedIds(messages: ExportedConversation["messages"]): Set<string> {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const shown = new Set<string>();
	for (let m = messages.at(-1); m && !shown.has(m.id); m = m.parentId ? byId.get(m.parentId) : undefined) {
		shown.add(m.id);
	}
	return shown;
}

export function toThunderbolt(
	conversations: ExportedConversation[],
	user: { id: string; email: string | null },
	exportedAt = new Date()
): ThunderboltEnvelope {
	const threads: ThunderboltThread[] = [];
	const rows: ThunderboltMessage[] = [];
	const at = exportedAt.toISOString();
	for (const c of conversations) {
		const start = ms(c.createdAt);
		const threadId = uuidv7At(Number.isNaN(start) ? exportedAt.getTime() : start, `alpha-thread:${c.id}`);
		threads.push({ id: threadId, title: c.title || null, deletedAt: null, userId: null });

		// Ids must rise in the order Alpha stored the messages, even where two share a millisecond or
		// one has no createdAt, or Thunderbolt would show an answer above its question.
		let last = Number.isNaN(start) ? exportedAt.getTime() : start - 1;
		const ids = new Map<string, string>();
		for (const m of c.messages) {
			const t = ms(m.createdAt);
			last = Math.max(last + 1, Number.isNaN(t) ? last + 1 : t);
			ids.set(m.id, uuidv7At(last, `alpha-message:${c.id}:${m.id}`));
		}
		const shown = displayedIds(c.messages);
		for (const m of c.messages) {
			const alpha: AlphaMetadata = {
				conversationId: c.id,
				messageId: m.id,
				...(m.parentId ? { parentId: m.parentId } : {}),
				...(m.createdAt ? { createdAt: m.createdAt } : {}),
				...(m.provenance ? { provenance: m.provenance } : {}),
				...(m.servedBy ? { servedBy: m.servedBy } : {}),
				...(m.aiGenerated ? { aiGenerated: true as const } : {}),
				...(m.digitalSourceType ? { digitalSourceType: m.digitalSourceType } : {}),
				...(m.interrupted ? { interrupted: true } : {}),
				...(m.moderation ? { moderation: m.moderation } : {}),
				...(m.files?.length ? { files: m.files } : {}),
			};
			// The conversation's own fields have no thread column, so its first message carries them.
			if (m === c.messages[0]) {
				Object.assign(alpha, {
					model: c.model,
					...(c.createdAt ? { conversationCreatedAt: c.createdAt } : {}),
					...(c.updatedAt ? { conversationUpdatedAt: c.updatedAt } : {}),
				});
			}
			const parts: TextPart[] = [{ type: "text", text: inertWidgets(m.content) }];
			rows.push({
				id: ids.get(m.id) as string,
				content: inertWidgets(m.content),
				role: m.from,
				parts,
				chatThreadId: threadId,
				// Thunderbolt's modelId names a row in its own models table, which an Alpha model is not.
				modelId: null,
				parentId: m.parentId ? (ids.get(m.parentId) ?? null) : null,
				cache: null,
				metadata: {
					...(m.sources?.length
						? { sources: m.sources.map((s, i) => ({ index: i + 1, url: s.url, title: s.title })) }
						: {}),
					alpha,
				},
				deletedAt: shown.has(m.id) ? null : at,
				userId: null,
			});
		}
	}
	return {
		format: THUNDERBOLT_FORMAT,
		schemaVersion: THUNDERBOLT_SCHEMA_VERSION,
		exportedAt: at,
		user,
		tables: { chat_threads: threads, chat_messages: rows },
	};
}

/** A Thunderbolt export read back as Alpha conversations, with every field Alpha has no home for. */
export type FromThunderbolt = {
	conversations: ExportedConversation[];
	/** `table.column` (or `chat_messages.parts[type]`, `chat_messages.metadata.key`) that carried data and was left behind. */
	dropped: string[];
};

const THREAD_KEPT = new Set(["id", "title", "deletedAt", "userId"]);
const MESSAGE_KEPT = new Set(["id", "content", "role", "parts", "chatThreadId", "parentId", "metadata", "deletedAt", "userId"]);
const METADATA_KEPT = new Set(["alpha", "sources", "modelId"]);

const present = (v: unknown) =>
	v !== null && v !== undefined && v !== "" && v !== 0 && !(typeof v === "object" && Object.keys(v as object).length === 0);

export function fromThunderbolt(envelope: unknown): FromThunderbolt {
	const e = envelope as Partial<ThunderboltEnvelope> | null;
	if (!e || e.format !== THUNDERBOLT_FORMAT || e.schemaVersion !== THUNDERBOLT_SCHEMA_VERSION || !e.tables) {
		throw new Error(`not a ${THUNDERBOLT_FORMAT} v${THUNDERBOLT_SCHEMA_VERSION} file`);
	}
	const dropped = new Set<string>();
	for (const [table, tableRows] of Object.entries(e.tables)) {
		if (table !== "chat_threads" && table !== "chat_messages" && Array.isArray(tableRows) && tableRows.length) {
			dropped.add(table);
		}
	}
	const threads = (e.tables.chat_threads ?? []) as (ThunderboltThread & Record<string, unknown>)[];
	const messages = [...((e.tables.chat_messages ?? []) as (ThunderboltMessage & Record<string, unknown>)[])].sort(
		(a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);

	const conversations: ExportedConversation[] = [];
	for (const t of threads.filter((t) => !t.deletedAt)) {
		for (const [k, v] of Object.entries(t)) if (!THREAD_KEPT.has(k) && present(v)) dropped.add(`chat_threads.${k}`);
		const own = messages.filter((m) => m.chatThreadId === t.id && m.role !== "system");
		const alphaIds = new Map(own.map((m) => [m.id, (m.metadata?.alpha as AlphaMetadata | undefined)?.messageId ?? m.id]));
		const first = own[0]?.metadata?.alpha as AlphaMetadata | undefined;
		const out: ExportedConversation["messages"] = [];
		for (const m of own) {
			for (const [k, v] of Object.entries(m)) if (!MESSAGE_KEPT.has(k) && present(v)) dropped.add(`chat_messages.${k}`);
			for (const [k, v] of Object.entries(m.metadata ?? {})) {
				if (!METADATA_KEPT.has(k) && present(v)) dropped.add(`chat_messages.metadata.${k}`);
			}
			for (const p of m.parts ?? []) if (p.type !== "text") dropped.add(`chat_messages.parts[${p.type}]`);
			const alpha = m.metadata?.alpha as AlphaMetadata | undefined;
			const parentId = alpha?.parentId ?? (m.parentId ? alphaIds.get(m.parentId) : undefined);
			const joined = (m.parts ?? [])
				.filter((p): p is TextPart => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text)
				.join("") || m.content || "";
			const text = alpha ? reviveWidgets(joined) : joined;
			const sources = (m.metadata?.sources as { url: string; title: string }[] | undefined) ?? [];
			out.push({
				id: alphaIds.get(m.id) as string,
				...(parentId ? { parentId } : {}),
				from: m.role === "assistant" ? "assistant" : "user",
				content: text,
				createdAt: alpha?.createdAt ?? uuidv7Time(m.id)?.toISOString(),
				...(alpha?.interrupted ? { interrupted: true } : {}),
				...(alpha?.aiGenerated || m.role === "assistant" ? { aiGenerated: true as const } : {}),
				...(alpha?.digitalSourceType ? { digitalSourceType: alpha.digitalSourceType as ExportedConversation["messages"][number]["digitalSourceType"] } : {}),
				...(alpha?.provenance ? { provenance: alpha.provenance } : {}),
				...(alpha?.servedBy ? { servedBy: alpha.servedBy } : {}),
				...(sources.length ? { sources: sources.map(({ title, url }) => ({ title, url })) } : {}),
				...(alpha?.moderation ? { moderation: alpha.moderation } : {}),
				...(alpha?.files?.length ? { files: alpha.files } : {}),
			});
		}
		const created = first?.conversationCreatedAt ?? uuidv7Time(t.id)?.toISOString();
		conversations.push({
			id: first?.conversationId ?? t.id,
			title: t.title ?? "",
			model: first?.model ?? "",
			createdAt: created,
			updatedAt: first?.conversationUpdatedAt ?? out.at(-1)?.createdAt,
			readable: "",
			messages: out,
		});
	}
	return { conversations, dropped: [...dropped].sort() };
}
