import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import {
	providerDisplay,
	resolveModelIdentity,
	servedByBackup,
	servedModelId,
} from "$lib/chat/identity";
import { backendDisplay, backendHost } from "$lib/chat/servingProvenance";
import { CHAT_HOST } from "$lib/chat/paths";
import { servingRecorded } from "$lib/chat/utils/routerMetadata";

// What the data export writes (CUR-1836). The account page promises "a ZIP of your conversations
// and files, with where each answer came from inside it", so the ZIP is written for the person who
// asked for it: a README saying what each file is, one readable markdown file per conversation with
// each answer's provenance in the words the chat itself shows, and a JSON copy built from named
// fields. The JSON never spreads whole records, which would carry `userId`, `sessionId`,
// `organizationId`, `userAgent` and the full timings block into a file meant for the person.
//
// No credential ever goes in the ZIP: not a session token, an OAuth access, refresh or id token, a
// storage or connector credential, or a tunnel secret, even the person's own (CUR-4183). A ZIP gets
// forwarded and uploaded elsewhere, and a token in it signs whoever holds it in as that person.
// `export.spec.ts` seeds a value in every credential column and fails if any reaches a file here; a
// new column named like a credential fails it too until the spec seeds or exempts it.

/** One message as the JSON export carries it. A field is here because the person would want it. */
type ExportedMessage = {
	id: string;
	/** The message this one replies to. Keeps an edited branch distinguishable from the main one. */
	parentId?: string;
	from: Message["from"];
	content: string;
	createdAt?: string;
	interrupted?: boolean;
	/** Set on every answer: this text was written by a model (EU AI Act Art. 50 marking, CUR-996). */
	aiGenerated?: true;
	/** The same fact in IPTC's digital-source-type vocabulary, which other software already reads. */
	digitalSourceType?: typeof TRAINED_ALGORITHMIC_MEDIA;
	/** The provenance line, exactly as written in the markdown copy. */
	provenance?: string;
	/** The model that served the answer, and the provider it ran on: its name, or the bare host. */
	servedBy?: { model?: string; backend?: string };
	sources?: { title: string; url: string }[];
	moderation?: { flagged: boolean; kind?: string };
	files?: string[];
};

export type ExportedConversation = {
	id: string;
	title: string;
	model: string;
	createdAt?: string;
	updatedAt?: string;
	/** Path of this conversation's readable copy inside the ZIP. */
	readable: string;
	messages: ExportedMessage[];
};

const iso = (d: Date | string | undefined) => (d ? new Date(d).toISOString() : undefined);

/** IPTC NewsCodes term for content a trained model produced, the value C2PA manifests use too. */
const TRAINED_ALGORITHMIC_MEDIA = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

/**
 * Where an answer came from, in the chat's own words: the source class (SourceStrip's "looked it
 * up" or SourceClass's "from training"), then the model the badge names (ProvenanceBadge), or the
 * chat's own sentence when nothing reported which model served it.
 */
function provenanceLine(message: Message, conversationModelId: string): string {
	const sources = message.webSearch?.sources ?? [];
	const sourceClass = sources.length
		? `looked it up · ${sources.length} open source${sources.length === 1 ? "" : "s"}${
				message.webSearch?.asOf ? ` · as of ${message.webSearch.asOf.slice(0, 10)}` : ""
			}`
		: "from training · no live sources";

	// Judge each answer against the model it was asked of, not the conversation's latest pick. (CUR-3234)
	const requestedModelId = message.requestedModel ?? conversationModelId;
	const modelId = servedModelId(message.routerMetadata, requestedModelId);
	if (!modelId) {
		return `${sourceClass}\nNo provenance for this answer — nothing reported which model served it.`;
	}
	const identity = resolveModelIdentity(modelId);
	const backup = servedByBackup(message.routerMetadata, requestedModelId, message.failover)
		? " (backup — served in place of the primary model)"
		: "";
	const compute = backendDisplay(message.routerMetadata?.backend);
	const via = providerDisplay(message.routerMetadata?.provider);
	const where = [via && `served via ${via}`, compute && `compute: ${compute}`].filter(Boolean);
	return `${sourceClass}\n${identity.short}${backup} · ${identity.maker} · ${
		where.length ? where.join(" · ") : "host not recorded"
	}`;
}

/**
 * The backend as a person may keep and share it: the institution's name, or the bare host for one we
 * have not named. Never the base URL, whose path can carry a provider account id (CUR-2186).
 */
function exportedBackend(backendBaseURL?: string): string | undefined {
	return backendDisplay(backendBaseURL) ?? (backendHost(backendBaseURL) || undefined);
}

/** The messages a reader saw: the branch ending at the most recent message, oldest first. */
function displayedBranch(messages: Message[]): Message[] {
	const visible = messages.filter((m) => m.from !== "system");
	const leaf = visible.at(-1);
	if (!leaf?.ancestors) return visible;
	const onBranch = new Set([...leaf.ancestors, leaf.id]);
	return visible.filter((m) => onBranch.has(m.id));
}

/** A filename-safe, readable stem: date, title words, and a short id so two titles never collide. */
export function readableName(conversation: Pick<Conversation, "_id" | "title" | "createdAt">): string {
	const date = iso(conversation.createdAt)?.slice(0, 10) ?? "undated";
	const words = (conversation.title || "untitled")
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 60)
		.replace(/-+$/, "");
	return `conversations/${date}-${words || "untitled"}-${conversation._id.toString().slice(-8)}.md`;
}

// An agent answer keeps its step log in a <think> block at the head of its content, and a reasoning
// model can leave that block unclosed. The chat folds it away (ChatMessage.svelte), so the readable
// copy drops it too; conversations.json keeps the content whole (CUR-4359). Only an answer's leading
// block goes: a person asking about the tag, or an answer quoting it, keeps every word.
function withoutLeadingThink(message: Message): string {
	const text = message.content.trim();
	if (message.from !== "assistant" || !text.startsWith("<think>")) return text;
	const end = text.indexOf("</think>");
	return end < 0 ? "" : text.slice(end + "</think>".length).trim();
}

export function conversationMarkdown(
	conversation: Conversation,
	filesByMessage: Map<string, string[]> = new Map()
): string {
	const lines = [
		`# ${conversation.title || "Untitled conversation"}`,
		"",
		`Started ${iso(conversation.createdAt)?.slice(0, 16).replace("T", " ") ?? "at an unknown time"} UTC.`,
		"",
	];
	for (const m of displayedBranch(conversation.messages)) {
		const text = withoutLeadingThink(m);
		lines.push(m.from === "user" ? "## You" : "## Alpha", "", text || "_(empty)_", "");
		const files = filesByMessage.get(m.id) ?? [];
		if (files.length) lines.push(...files.map((f) => `Attached: \`${f}\``), "");
		if (m.from !== "assistant") continue;
		if (m.interrupted) lines.push("_This answer was stopped before it finished._", "");
		const provenance = provenanceLine(m, conversation.model).split("\n");
		lines.push(...provenance.map((l) => `> ${l}`), "");
		for (const [i, s] of (m.webSearch?.sources ?? []).entries()) {
			lines.push(`${i + 1}. [${s.title}](${s.url})`);
		}
		if (m.webSearch?.sources.length) lines.push("");
	}
	return lines.join("\n");
}

export function exportedConversation(
	conversation: Conversation,
	filesByMessage: Map<string, string[]> = new Map()
): ExportedConversation {
	return {
		id: conversation._id.toString(),
		title: conversation.title,
		model: conversation.model,
		createdAt: iso(conversation.createdAt),
		updatedAt: iso(conversation.updatedAt),
		readable: readableName(conversation),
		messages: conversation.messages
			.filter((m) => m.from !== "system")
			.map((m) => ({
				id: m.id,
				...(m.ancestors?.length ? { parentId: m.ancestors.at(-1) } : {}),
				from: m.from,
				content: m.content,
				createdAt: iso(m.createdAt),
				...(m.interrupted ? { interrupted: true } : {}),
				...(m.from === "assistant"
					? {
							aiGenerated: true as const,
							digitalSourceType: TRAINED_ALGORITHMIC_MEDIA,
							provenance: provenanceLine(m, conversation.model),
							...(m.routerMetadata && servingRecorded(m.routerMetadata)
								? { servedBy: { model: m.routerMetadata.model, backend: exportedBackend(m.routerMetadata.backend) } }
								: {}),
						}
					: {}),
				...(m.webSearch?.sources.length
					? { sources: m.webSearch.sources.map(({ title, url }) => ({ title, url })) }
					: {}),
				...(m.moderation ? { moderation: { flagged: m.moderation.flagged, kind: m.moderation.kind } } : {}),
				...(filesByMessage.get(m.id)?.length ? { files: filesByMessage.get(m.id) } : {}),
			})),
	};
}

// conversations.json names its own format and version, and the account it came from, so an import can
// refuse a file it cannot read, or one from someone else, before writing anything (CUR-4180). The shape
// borrows Thunderbolt's export envelope (`format`, `schemaVersion`, `exportedAt`); none of its code.
export const EXPORT_FORMAT = "alpha-export";
export const EXPORT_SCHEMA_VERSION = 1;
/** Larger than any account holds today; past it an import would read the whole file into memory. */
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024;

export type ExportEnvelope = {
	format: typeof EXPORT_FORMAT;
	schemaVersion: typeof EXPORT_SCHEMA_VERSION;
	exportedAt: string;
	/** The account the file came from, compared on import. The same id the account's storage is keyed by. */
	account: { id: string };
	conversations: ExportedConversation[];
};

export function exportEnvelope(
	accountId: string,
	conversations: ExportedConversation[],
	at: Date = new Date()
): ExportEnvelope {
	return {
		format: EXPORT_FORMAT,
		schemaVersion: EXPORT_SCHEMA_VERSION,
		exportedAt: at.toISOString(),
		account: { id: accountId },
		conversations,
	};
}

export class ExportFileError extends Error {
	constructor(
		readonly reason: "too-large" | "not-json" | "format" | "version" | "account",
		message: string
	) {
		super(message);
		this.name = "ExportFileError";
	}
}

/**
 * Checks a conversations.json before an import writes anything from it, and returns it parsed. Throws
 * ExportFileError for a file over the size cap, one that is not ours, a version this code does not
 * know (including the bare list every export wrote before versions), or another account's file.
 */
export function validateExportFile(text: string, accountId: string): ExportEnvelope {
	if (Buffer.byteLength(text, "utf8") > EXPORT_MAX_BYTES) {
		throw new ExportFileError("too-large", `The file is over ${EXPORT_MAX_BYTES / 1024 / 1024} MB.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ExportFileError("not-json", "The file is not JSON.");
	}
	if (Array.isArray(parsed)) {
		throw new ExportFileError("version", "The file is from an export made before exports carried a version.");
	}
	const file = (parsed ?? {}) as Partial<ExportEnvelope>;
	if (file.format !== EXPORT_FORMAT) {
		throw new ExportFileError("format", "The file is not an AI Potluck export.");
	}
	if (file.schemaVersion !== EXPORT_SCHEMA_VERSION) {
		throw new ExportFileError("version", `The file is export version ${String(file.schemaVersion)}, which this version cannot read.`);
	}
	if (file.account?.id !== accountId) {
		throw new ExportFileError("account", "The file was exported from a different account.");
	}
	if (!Array.isArray(file.conversations)) {
		throw new ExportFileError("format", "The file has no list of conversations.");
	}
	return file as ExportEnvelope;
}

export function readme(counts: {
	conversations: number;
	files: number;
	filesSkipped: number;
	/** The stored-file listing itself failed, so the count of stored files is unknown. */
	listingFailed?: boolean;
	/** Set when the person has taken part in human evaluation. */
	humanEvalRatings?: number;
}): string {
	return [
		"# Your AI Potluck data",
		"",
		`Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
		"",
		"## What's in this folder",
		"",
		`- \`conversations/\` holds ${counts.conversations} conversation${counts.conversations === 1 ? "" : "s"}, one readable file each. Under every answer, a quoted line says where it came from: whether Alpha looked it up in open sources or answered from its training, and which model served it, as the chat showed it.`,
		counts.listingFailed
			? "- Your stored files could not be listed when this export ran, so none are included. Export again later."
			: counts.files === 0 && !counts.filesSkipped
				? "- You had no stored files when this export ran, so there is no `files/` folder."
				: `- \`files/\` holds the ${counts.files} file${counts.files === 1 ? "" : "s"} you stored with us. Files you uploaded keep the folders you put them in. A file you attached in a chat is under \`files/conversations/\`, and that conversation's readable file names its path under the message it came with.`,
		...(counts.filesSkipped
			? [
					`- ${counts.filesSkipped} stored file${counts.filesSkipped === 1 ? "" : "s"} could not be read when this export ran and ${counts.filesSkipped === 1 ? "is" : "are"} missing here. Export again later, or download ${counts.filesSkipped === 1 ? "it" : "them"} from Your files (${CHAT_HOST}/chat/storage).`,
				]
			: []),
		`- \`conversations.json\` holds the same conversations in a form other software can read. It opens with \`"format": "${EXPORT_FORMAT}"\` and \`"schemaVersion": ${EXPORT_SCHEMA_VERSION}\`, so a program reading it knows which layout it is, and the list itself is under \`conversations\`.`,
		"- Each answer in `conversations.json` carries the same provenance line, the model that served it and the provider it ran on, and any sources it cited. Every answer is also marked `\"aiGenerated\": true`, with IPTC's `trainedAlgorithmicMedia` as its `digitalSourceType`, so software can tell model-written text from yours.",
		...(counts.humanEvalRatings !== undefined
			? [
					`- \`human-evaluation.json\` holds the languages you evaluate models in, the level you declared, when you agreed to how ratings are used, and your ${counts.humanEvalRatings} rating${counts.humanEvalRatings === 1 ? "" : "s"}, each with the request and answer you rated.`,
				]
			: []),
		"",
		"Answers written from training can be wrong and cannot be reliably dated.",
		"",
	].join("\n");
}
