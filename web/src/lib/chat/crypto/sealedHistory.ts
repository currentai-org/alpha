// Reading sealed conversations in the browser (stage 3).
//
// No new cryptography: each blob is an ordinary age v1 file sealed to the owner's history recipient
// (`sealToRecipient` does the same on the server), opened with typage's Decrypter and the identity
// historyIdentity.ts unlocked. What this file adds is the binding. age has no associated data, so the
// plaintext is a JSON `SealedEnvelope` naming the slot it was sealed for, and a blob is shown only in
// that slot. Anything else, including a blob moved from another message or an older revision, reads as
// `unreadable`; there is no path that shows its text anyway. What the binding does not give is
// authenticity: see sealedShape.ts.

import { Decrypter, Encrypter } from 'age-encryption';
import type { Message, MessageFile } from '$lib/chat/types/Message';
import type { MessageUpdate } from '$lib/chat/types/MessageUpdate';
import {
	SKELETON_MESSAGE_FIELDS,
	hasSealedFields,
	MAC_SALT_PATTERN,
	updateSkeleton,
	type SealableConversation,
	type SealedEnvelope,
	type SealedMessageField,
	type SealedState
} from './sealedShape';
import { rememberBody, rememberPreprompt, sealedHistoryForTurn, sentBody, sentPreprompt } from './openedHistory';

const toBase64 = (bytes: Uint8Array) => {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Seal one envelope to a history recipient, as the stored base64 string. Stage 4 writes with this;
 *  tests use it to make sealed docs. */
export async function sealEnvelope(recipient: string, envelope: SealedEnvelope): Promise<string> {
	const e = new Encrypter();
	e.addRecipient(recipient);
	return toBase64(await e.encrypt(JSON.stringify(envelope)));
}

type Shape = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * The JSON shape each sealed field must have to be copied into the view. A field of another shape is
 * dropped, so a body cannot hand the renderer a string where it reads an array. Keyed by every sealed
 * field, so a field added to `Message` fails the type check here until it is given a shape.
 */
const BODY_SHAPES: Record<SealedMessageField, Shape> = {
	content: 'string',
	origin: 'string',
	reasoning: 'string',
	webSearch: 'object',
	searchAttempt: 'object',
	rag: 'object',
	mcp: 'object',
	writePolicy: 'object',
	agentTools: 'object',
	unrunCode: 'object',
	agentConfirmations: 'array',
	moderation: 'object',
	outputModeration: 'object',
	nameNotice: 'object',
	fixedReply: 'object',
	autoRoute: 'object',
	calculations: 'array',
	mathLedger: 'object',
	mcpCalls: 'array',
	failover: 'object',
	safetyNotice: 'object',
	attachmentNotice: 'object',
	leftOutFiles: 'array',
	unreadFilesNotice: 'string',
	historyLeftOut: 'number',
	agentRouteFailed: 'boolean',
	urlNotice: 'object',
	labelNotice: 'object',
	sourceNotice: 'object',
	groundedHedgeNotice: 'object',
	groundcheckNotice: 'object',
	opinions: 'array',
	unanswered: 'array',
	verdict: 'object'
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function hasShape(value: unknown, shape: Shape): boolean {
	switch (shape) {
		case 'array':
			return Array.isArray(value);
		case 'object':
			return isRecord(value);
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		default:
			return typeof value === shape;
	}
}

const isRev = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

type Slot = { conversationId: string; rev: number | undefined } & (
	| { kind: 'message'; messageId: string }
	| { kind: 'title' | 'preprompt' }
);

/** Open one blob for one slot, or null when it does not open there. Never throws. */
async function openForSlot(blob: string, identity: string, slot: Slot): Promise<SealedEnvelope | null> {
	if (!isRev(slot.rev)) return null;
	let parsed: unknown;
	try {
		const d = new Decrypter();
		d.addIdentity(identity);
		parsed = JSON.parse(await d.decrypt(fromBase64(blob), 'text'));
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.v !== 1) return null;
	if (parsed.kind !== slot.kind || parsed.conversationId !== slot.conversationId) return null;
	if (!isRev(parsed.rev) || parsed.rev !== slot.rev) return null;
	if (slot.kind === 'message') {
		if (parsed.messageId !== slot.messageId || !isRecord(parsed.body)) return null;
	} else if (typeof parsed.text !== 'string') {
		return null;
	}
	if (parsed.salt !== undefined && (typeof parsed.salt !== 'string' || !MAC_SALT_PATTERN.test(parsed.salt))) return null;
	return parsed as SealedEnvelope;
}

/** The plaintext view of a sealed message before its body opens: the skeleton fields only, each file's
 *  name blanked and each update cut to its structure, so nothing sealed or stale can render. */
function skeletonOf(message: Message): Message {
	const out = { content: '' } as Message;
	const src = message as Record<string, unknown>;
	const dst = out as Record<string, unknown>;
	for (const f of SKELETON_MESSAGE_FIELDS) {
		if (f !== 'sealed' && src[f] !== undefined) dst[f] = src[f];
	}
	if (Array.isArray(message.files)) out.files = message.files.map((f) => ({ ...f, name: '' }));
	else delete out.files;
	if (Array.isArray(message.updates)) {
		out.updates = message.updates.map(updateSkeleton).filter((u): u is MessageUpdate => u !== null);
	} else {
		delete out.updates;
	}
	return out;
}

function withFileNames(files: MessageFile[] | undefined, names: unknown): MessageFile[] | undefined {
	if (!files || !isRecord(names)) return files;
	return files.map((f) => {
		const name = f.type === 'hash' && Object.hasOwn(names, f.value) ? names[f.value] : undefined;
		return typeof name === 'string' ? { ...f, name } : f;
	});
}

/** One message's plaintext view. A message without `sealed` comes back as the same object. */
export async function openSealedMessage(
	message: Message,
	conversationId: string,
	identity: string | null
): Promise<Message> {
	if (!message.sealed) return message;
	const skeleton = skeletonOf(message);
	if (!identity) {
		// What this tab sent itself at this revision (the create route's echo) shows without a key.
		const kept = sentBody(conversationId, message.id, message.sealedRev);
		return kept ? viewOf(skeleton, kept) : { ...skeleton, sealedState: 'locked' };
	}
	const env = await openForSlot(message.sealed, identity, {
		kind: 'message',
		conversationId,
		messageId: message.id,
		rev: message.sealedRev
	});
	if (!env || env.kind !== 'message') return { ...skeleton, sealedState: 'unreadable' };
	const body = env.body as Record<string, unknown>;
	rememberBody(conversationId, message.id, env.rev, body, env.salt);
	return viewOf(skeleton, body);
}

/** A sealed message's view: its skeleton with the opened body's fields put back. */
function viewOf(skeleton: Message, body: Record<string, unknown>): Message {
	const opened = { ...skeleton } as Record<string, unknown>;
	for (const [f, shape] of Object.entries(BODY_SHAPES)) {
		if (Object.hasOwn(body, f) && hasShape(body[f], shape)) opened[f] = body[f];
	}
	if (Array.isArray(body.updates)) {
		opened.updates = body.updates.filter((u) => isRecord(u) && typeof u.type === 'string');
	}
	const view = opened as Message;
	if (typeof view.content !== 'string') view.content = '';
	view.files = withFileNames(skeleton.files, body.fileNames);
	if (view.files === undefined) delete view.files;
	return view;
}

/** A sealed title or preprompt, opened for its conversation at its revision. */
export async function openSealedText(
	blob: string,
	kind: 'title' | 'preprompt',
	conversationId: string,
	rev: number | undefined,
	identity: string | null
): Promise<{ text: string; state?: SealedState; salt?: string }> {
	if (!identity) {
		const kept = kind === 'preprompt' ? sentPreprompt(conversationId, rev) : undefined;
		if (!kept) return { text: '', state: 'locked' };
		return kept.salt !== undefined ? { text: kept.text, salt: kept.salt } : { text: kept.text };
	}
	const env = await openForSlot(blob, identity, { kind, conversationId, rev });
	if (!env || env.kind === 'message') return { text: '', state: 'unreadable' };
	return env.kind === 'preprompt' && env.salt !== undefined ? { text: env.text, salt: env.salt } : { text: env.text };
}

type SealedConversationKeys = 'sealedTitle' | 'sealedTitleRev' | 'sealedPreprompt' | 'sealedPrepromptRev';

export type OpenedConversation<T> = Omit<T, SealedConversationKeys> & {
	/** Set when the title was sealed and did not open. */
	titleState?: SealedState;
	/** Set when the preprompt was sealed and did not open. */
	prepromptState?: SealedState;
};

/**
 * The plaintext view of a conversation, for an unlocked identity or for none (`null`: this browser has
 * not unlocked, or the server is rendering). A conversation with nothing sealed comes back as the same
 * object, untouched. A sealed part that does not open shows no text and says why (`sealedState`,
 * `titleState`, `prepromptState`); its ciphertext never reaches the view.
 *
 * `conversationId` is the id the page asked for (the URL's), never the doc's own `id`: every blob is
 * bound to it, and a doc that names another id opens nothing sealed, so a server cannot serve one
 * conversation's blobs at another's address.
 */
export async function openConversationDoc<T extends SealableConversation>(
	doc: T,
	conversationId: string,
	identity: string | null
): Promise<OpenedConversation<T>> {
	if (!hasSealedFields(doc)) return doc as OpenedConversation<T>;
	const { sealedTitle, sealedTitleRev, sealedPreprompt, sealedPrepromptRev, ...rest } = doc;
	const view = { ...rest } as OpenedConversation<T> & SealableConversation;
	const misfiled = doc.id !== conversationId;

	view.messages = await Promise.all(
		doc.messages.map((m) =>
			misfiled && m.sealed
				? { ...skeletonOf(m), sealedState: 'unreadable' as const }
				: openSealedMessage(m, conversationId, identity)
		)
	);
	const openText = async (
		blob: string,
		kind: 'title' | 'preprompt',
		rev: number | undefined
	): Promise<{ text: string; state?: SealedState; salt?: string }> =>
		misfiled
			? { text: '', state: 'unreadable' as const }
			: await openSealedText(blob, kind, conversationId, rev, identity);
	if (sealedTitle) {
		const t = await openText(sealedTitle, 'title', sealedTitleRev);
		view.title = t.text;
		if (t.state) view.titleState = t.state;
	}
	if (sealedPreprompt) {
		const p = await openText(sealedPreprompt, 'preprompt', sealedPrepromptRev);
		// Personal instructions win over the conversation's own (effectivePreprompt), so the page keeps
		// showing them; the opened text is still remembered for the turn to post back.
		if (!doc.personalInstructionsApply) view.preprompt = p.text;
		if (p.state) view.prepromptState = p.state;
		else if (typeof sealedPrepromptRev === 'number') {
			rememberPreprompt(conversationId, sealedPrepromptRev, p.text, p.salt);
		}
	}
	return view;
}

/**
 * Open a conversation as the server stores it now, so this tab holds every sealed body at its current
 * revision, and return what a turn posts for it. For a turn the server refused because it
 * was sent before the previous turn's reload brought back the messages that turn sealed. The bodies
 * come from the stored blobs, opened here, so nothing is posted that the server did not seal itself.
 */
export async function reopenForTurn(
	doc: SealableConversation,
	conversationId: string,
	identity: string | null
): Promise<ReturnType<typeof sealedHistoryForTurn>> {
	await openConversationDoc(doc, conversationId, identity);
	return sealedHistoryForTurn(
		conversationId,
		doc.messages.map((m) => m.id)
	);
}
