// The server's half of sealed conversation history.
//
// Two jobs, and neither needs the owner's history identity:
// - Seal on persist. A message or title a request wrote is sealed to the owner's public history
//   recipient with `sealToRecipient`, in the stage 3 envelope (`SealedEnvelope`, sealedShape.ts), and
//   stored as its skeleton plus `sealed`, `sealedRev` and `sealedMac`.
// - Take a turn's history from the browser. The server cannot open what it sealed, so the browser posts
//   each sealed message's opened body. Each must carry the revision the stored skeleton names and match
//   the stored `sealedMac`, an HMAC-SHA-256 under a server secret kept apart from the database; anything
//   else is refused. The skeleton (ids, roles, tree links, order) always comes from storage, never from
//   the post, so the post can change nothing but the words, and the MAC pins those.
//
// Sealing is the `history-seal-writes` PostHog flag, read per account, so it can be staged to
// team accounts before everyone. With it on and no custodial storage, a write fails loudly. An
// owner who has not enrolled a history key yet has nothing to seal to, and their turns are written in
// plaintext; the backfill (sealBackfill.ts) seals those with public keys only. A guest's new chats are
// written in plaintext too, until a sign-in handover moves the guest key to the account. An owner whose
// history key was destroyed (account deletion) gets nothing written at all. A failure to read the recipient or the secret fails the write;
// it never falls back to plaintext. A chat that is already sealed stays sealed with the switch off: its
// writes are sealed anyway, or refused.
//
// The MAC keys carry key ids, so one can be rotated while chats sealed under the old one stay usable, and
// each MAC covers a random salt that exists only inside the sealed blob, so a database copy plus the key
// cannot confirm a guessed message (`macRing`, `saltedSlotMac`).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { error } from "@sveltejs/kit";
import { chatRequestSchema } from "$lib/chat/server/chat/requestSchema";
import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { ownerGrant, sealToRecipient } from "$lib/chat/server/storage/custodialCrypto";
import { custodialKeyBucket, custodialStorageConfigured } from "$lib/chat/server/storage/custodialStorage";
import { readHistoryHolder, readHistoryRecipient } from "$lib/chat/server/storage/historyKey";
import { SKELETON_MESSAGE_FIELDS, type SealedEnvelope, updateSkeleton } from "$lib/chat/crypto/sealedShape";
import type { Message } from "$lib/chat/types/Message";
import type { MessageUpdate } from "$lib/chat/types/MessageUpdate";

export const HISTORY_SEAL_WRITES_FLAG = "history-seal-writes";

/** Whether this request's writes are sealed: the `history-seal-writes` flag, the requesting account's
 *  answer in a request and the deployment's elsewhere (a script). Off wherever PostHog has no answer. */
export function conversationSealWritesOn(): boolean {
	return flagEnabledOr(HISTORY_SEAL_WRITES_FLAG, () => false);
}

/** Why a turn's history was refused. Each is the browser's to fix (unlock, reload), never a 500. */
export class SealedHistoryError extends Error {
	override name = "SealedHistoryError";
	constructor(
		readonly code: "history_missing" | "history_mismatch" | "history_unexpected" | "mac_key_missing",
		message: string
	) {
		super(message);
	}
}

const MIN_MAC_KEY_BYTES = 32;
/** The key id of `CONVERSATION_HISTORY_MAC_KEY`, and of every MAC stored before key ids existed. */
export const LEGACY_MAC_KID = "k0";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One MAC key's bytes, or null. Strict: lower- or upper-case hex of even length, or base64 / base64url
 * that decodes and re-encodes to the same text, and 32 bytes or more either way. Node's base64 decoder
 * skips characters it does not know, so without the round trip a placeholder sentence decodes to 32
 * bytes and passes for a key.
 */
export function parseMacKey(raw: string): Buffer | null {
	const text = raw.trim();
	let bytes: Buffer | null = null;
	if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) bytes = Buffer.from(text, "hex");
	else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
		const decoded = Buffer.from(text, "base64");
		const unpadded = text.replace(/=+$/, "");
		const again = text.includes("-") || text.includes("_") ? decoded.toString("base64url") : decoded.toString("base64").replace(/=+$/, "");
		if (again === unpadded) bytes = decoded;
	}
	return bytes && bytes.length >= MIN_MAC_KEY_BYTES ? bytes : null;
}

/** The MAC keys this deployment holds, by key id, and the one new MACs are taken under. */
export type MacRing = { keys: ReadonlyMap<string, Buffer>; active: string | null };

const loggedRingProblems = new Set<string>();
function ringProblem(problem: string, detail: Record<string, unknown> = {}): void {
	if (loggedRingProblems.has(problem)) return;
	loggedRingProblems.add(problem);
	logger.error({ event: "history-mac-key-rejected", problem, ...detail }, `[sealed-turn] history MAC key config: ${problem}`);
}

/**
 * The MAC keys from config, so a key can be rotated without losing a sealed chat:
 * - `CONVERSATION_HISTORY_MAC_KEYS`, JSON `{"<kid>": "<hex or base64>"}`, the shape of
 *   `CUSTODIAL_MASTER_KMS_KEYS`. A kid is 1-64 of `A-Z a-z 0-9 _ -`.
 * - `CONVERSATION_HISTORY_MAC_KEY`, the single key from before key ids, held as kid `k0`. The map's own
 *   `k0`, when it has one, wins.
 * - `CONVERSATION_HISTORY_MAC_KEY_ACTIVE` names the kid new MACs use. Unset, the only key is active, or
 *   `k0` when there are several.
 * A value that fails `parseMacKey` is dropped and logged, never used.
 */
export function macRing(): MacRing {
	const keys = new Map<string, Buffer>();
	const single = config.CONVERSATION_HISTORY_MAC_KEY?.trim();
	if (single) {
		const key = parseMacKey(single);
		if (key) keys.set(LEGACY_MAC_KID, key);
		else ringProblem("CONVERSATION_HISTORY_MAC_KEY is not 32 or more bytes of strict hex or base64");
	}
	const rawMap = config.CONVERSATION_HISTORY_MAC_KEYS?.trim();
	if (rawMap) {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(rawMap);
		} catch {
			ringProblem("CONVERSATION_HISTORY_MAC_KEYS is not JSON");
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [kid, value] of Object.entries(parsed)) {
				const key = KID_PATTERN.test(kid) && typeof value === "string" ? parseMacKey(value) : null;
				if (key) keys.set(kid, key);
				else ringProblem("a CONVERSATION_HISTORY_MAC_KEYS entry has a bad kid or a value that is not a key", { kid: KID_PATTERN.test(kid) ? kid : "(invalid)" });
			}
		} else if (parsed !== null) ringProblem("CONVERSATION_HISTORY_MAC_KEYS is not a JSON object");
	}
	const wanted = config.CONVERSATION_HISTORY_MAC_KEY_ACTIVE?.trim();
	let active: string | null = null;
	if (wanted) {
		if (keys.has(wanted)) active = wanted;
		else ringProblem("CONVERSATION_HISTORY_MAC_KEY_ACTIVE names a kid with no key", { kid: KID_PATTERN.test(wanted) ? wanted : "(invalid)" });
	} else if (keys.size === 1) active = [...keys.keys()][0];
	else if (keys.has(LEGACY_MAC_KID)) active = LEGACY_MAC_KID;
	else if (keys.size > 1) ringProblem("several MAC keys and no CONVERSATION_HISTORY_MAC_KEY_ACTIVE");
	return withE2eRotation({ keys, active });
}

/** The kid the `history_mac_key_rotated` fault rotates to. */
export const E2E_ROTATED_MAC_KID = "e2e-rotated";

/**
 * Under the `history_mac_key_rotated` fault (a preview's scenario send only, faultInjection.ts), the ring
 * as an operator's rotation leaves it: every configured key kept for checking, and a new key, derived
 * from the active one, made active. A deployment's MAC keys are environment config, so a browser spec
 * cannot rotate them for one request any other way.
 */
function withE2eRotation(ring: MacRing): MacRing {
	if (!getRequestContext()?.macKeyRotated || !ring.active) return ring;
	const rotated = createHmac("sha256", ring.keys.get(ring.active)!).update("alpha-e2e-rotated-mac-key-v1").digest();
	const keys = new Map(ring.keys);
	keys.set(E2E_ROTATED_MAC_KID, rotated);
	return { keys, active: E2E_ROTATED_MAC_KID };
}

/** The ring with its active key, or a mac_key_missing SealedHistoryError: what every sealing path checks
 *  first. */
export function requireMacKey(): MacRing & { active: string } {
	const ring = macRing();
	if (ring.active) return ring as MacRing & { active: string };
	logger.error({ event: "history-mac-key-missing" }, "[sealed-turn] no usable history MAC key (CONVERSATION_HISTORY_MAC_KEY or _KEYS with an active kid)");
	throw new SealedHistoryError("mac_key_missing", "this deployment has no history MAC key, so sealed history cannot be checked or written");
}

/** The ring, or mac_key_missing when it holds no key at all: what checking a posted body needs. A ring
 *  with keys but no active one still checks; it only cannot write. */
function requireMacRingToCheck(): MacRing {
	const ring = macRing();
	if (ring.keys.size > 0) return ring;
	return requireMacKey();
}

/** JSON with every object's keys sorted, so one value has one serialization however it was built. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_k, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, (v as Record<string, unknown>)[k]])
				)
			: v
	);
}

type MacSlot = { kind: SealedEnvelope["kind"]; conversationId: string; messageId?: string; rev: number };

/** The unsalted MAC of one slot's plaintext at one revision, base64url, the form MACs took before
 *  key ids. Still checked, under kid `k0`, never written. Covers the slot and the `rev` as
 *  well as the words, so a body cannot be moved to another message or replayed at another revision. */
export function slotMac(key: Buffer, slot: MacSlot, plaintext: unknown): string {
	const input = canonicalJson(["alpha-history-mac-v1", slot.kind, slot.conversationId, slot.messageId ?? "", slot.rev, plaintext]);
	return createHmac("sha256", key).update(input).digest("base64url");
}

/** A stored MAC as written now: `m2.<kid>.<HMAC-SHA-256 over the slot, the salt and the plaintext>`. The
 *  salt is the envelope's (`SealedEnvelope.salt`), or "" for a blob sealed without one. */
export function saltedSlotMac(kid: string, key: Buffer, slot: MacSlot, plaintext: unknown, salt: string): string {
	const input = canonicalJson(["alpha-history-mac-v2", slot.kind, slot.conversationId, slot.messageId ?? "", slot.rev, salt, plaintext]);
	return `m2.${kid}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

/** A fresh envelope salt: 32 random bytes, base64url. */
export function newMacSalt(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Check a posted body against its stored MAC. `restamp` is set when the MAC matched under a key that is
 * not the active one, or in the unsalted form: the same check's MAC under the active key, for the caller
 * to store so the old key can be retired.
 */
function checkMac(
	ring: MacRing,
	slot: MacSlot,
	plaintext: unknown,
	salt: string | undefined,
	stored: string | undefined
): { ok: false } | { ok: true; restamp?: string } {
	if (!stored) return { ok: false };
	let want: string;
	let kid: string;
	if (stored.startsWith("m2.")) {
		const parts = stored.split(".");
		const key = parts.length === 3 ? ring.keys.get(parts[1]) : undefined;
		if (!key) return { ok: false };
		kid = parts[1];
		want = saltedSlotMac(kid, key, slot, plaintext, salt ?? "");
	} else {
		const key = ring.keys.get(LEGACY_MAC_KID);
		// A body posted with a salt was sealed after salts existed, so its MAC was never unsalted.
		if (!key || salt !== undefined) return { ok: false };
		kid = LEGACY_MAC_KID;
		want = slotMac(key, slot, plaintext);
	}
	const a = Buffer.from(want);
	const b = Buffer.from(stored);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
	const fresh = stored.startsWith("m2.") && kid === ring.active;
	if (fresh || !ring.active) return { ok: true };
	return { ok: true, restamp: saltedSlotMac(ring.active, ring.keys.get(ring.active)!, slot, plaintext, salt ?? "") };
}

/** MACs a checked post showed to be under an old key or the unsalted form, each with its replacement under
 *  the active key, keyed to the revision it was checked at (`restampSealedMacs` stores them). */
export type MacRestamps = {
	messages: { id: string; rev: number; sealedMac: string }[];
	preprompt?: { rev: number; sealedPrepromptMac: string };
};

/** Whether a stored conversation holds anything sealed: a message, the title or the preprompt. */
export function rowHasSealedParts(row: { messages?: Message[]; sealedTitle?: string; sealedPreprompt?: string }): boolean {
	return Boolean(row.sealedTitle || row.sealedPreprompt || row.messages?.some((m) => m.sealed));
}

const SKELETON = new Set<string>(SKELETON_MESSAGE_FIELDS);
/** Never stored, so never sealed: render-only flags. */
const NEVER_STORED = new Set(["sealedState", "servedFromCache"]);
/** The seal itself, which a new seal replaces. */
const SEAL_FIELDS = new Set(["sealed", "sealedRev", "sealedMac"]);

/**
 * A message split into what stays plaintext and what is sealed, as stage 3's reader expects: every field
 * not in `SKELETON_MESSAGE_FIELDS` goes in the body, the updates' text and the file names too. The
 * skeleton keeps `content: ""` so code that reads `content` on a stored message sees a string.
 */
export function splitMessage(message: Message): { skeleton: Message; body: Record<string, unknown> } {
	const skeleton: Record<string, unknown> = {};
	const body: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(message)) {
		if (v === undefined || NEVER_STORED.has(k) || SEAL_FIELDS.has(k)) continue;
		if (SKELETON.has(k)) skeleton[k] = v;
		else body[k] = v;
	}
	if (Array.isArray(message.updates)) {
		body.updates = message.updates;
		skeleton.updates = message.updates.map(updateSkeleton).filter((u): u is MessageUpdate => u !== null);
	}
	if (Array.isArray(message.files)) {
		const names: Record<string, string> = {};
		for (const f of message.files) if (f.type === "hash" && f.name) names[f.value] = f.name;
		if (Object.keys(names).length) body.fileNames = names;
		skeleton.files = message.files.map((f) => ({ ...f, name: "" }));
	}
	// The length the usage counts sum in place of the sealed `content` (accountUsage.ts).
	skeleton.chars = typeof message.content === "string" ? message.content.length : 0;
	skeleton.content = "";
	return { skeleton: skeleton as Message, body };
}

/** The stored skeleton with a body put back: what `splitMessage` took apart, without the seal. */
function joinMessage(stored: Message, body: Record<string, unknown>): Message {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(stored)) if (k !== "sealed" && k !== "sealedMac") out[k] = v;
	for (const [k, v] of Object.entries(body)) {
		// The skeleton is storage's; a body cannot move a message, relink it or relabel its author.
		if (SKELETON.has(k) || k === "fileNames" || NEVER_STORED.has(k)) continue;
		out[k] = v;
	}
	if (Array.isArray(body.updates)) out.updates = body.updates;
	const names = body.fileNames;
	if (Array.isArray(stored.files) && names && typeof names === "object") {
		out.files = stored.files.map((f) => {
			const name = (names as Record<string, unknown>)[f.value];
			return typeof name === "string" ? { ...f, name } : f;
		});
	}
	if (typeof out.content !== "string") out.content = "";
	return out as Message;
}

/** A stored sealed message with the posted body put back, once the body carries the stored revision and
 *  matches the stored MAC. */
function checkedJoin(
	ring: MacRing,
	stored: Message,
	conversationId: string,
	posted: TurnHistoryEntry,
	restamps?: MacRestamps
): Message {
	const slot = { kind: "message" as const, conversationId, messageId: stored.id, rev: posted.rev };
	const checked = posted.rev === stored.sealedRev ? checkMac(ring, slot, posted.body, posted.salt, stored.sealedMac) : { ok: false as const };
	if (!checked.ok) throw new SealedHistoryError("history_mismatch", "the history sent does not match this chat as stored");
	if (checked.restamp) restamps?.messages.push({ id: stored.id, rev: posted.rev, sealedMac: checked.restamp });
	return joinMessage(stored, posted.body);
}

/**
 * One stored sealed message as plaintext, from the body the browser opened and posted, checked as a turn's
 * history is: the same id, the stored revision, and the stored MAC. For a request that touches
 * a single message, such as the stop clamp, rather than a whole turn's branch.
 *
 * @throws SealedHistoryError when the post names another message, or carries another revision or body.
 */
export function hydrateSealedMessage(stored: Message, conversationId: string, posted: TurnHistoryEntry): Message {
	if (!stored.sealed) throw new SealedHistoryError("history_unexpected", "a body was sent for a message that is not sealed");
	if (posted.id !== stored.id) throw new SealedHistoryError("history_unexpected", "the body sent names another message");
	return checkedJoin(requireMacRingToCheck(), stored, conversationId, posted);
}

/** One sealed message's opened body, as the browser posts it, with its envelope's salt when it has one. */
export type TurnHistoryEntry = { id: string; rev: number; body: Record<string, unknown>; salt?: string };
/** The opened preprompt, as the browser posts it. */
export type TurnPreprompt = { rev: number; text: string; salt?: string };

type HistoryConversation = {
	messages: Message[];
	preprompt?: string;
	sealedPreprompt?: string;
	sealedPrepromptRev?: number;
	sealedPrepromptMac?: string;
};

/**
 * Put a turn's posted history into the loaded conversation, in place: each sealed message becomes its
 * plaintext, each from the post, checked against the stored revision and MAC. Messages stored in
 * plaintext pass through. Afterwards the turn reads `conv.messages` and `conv.preprompt` as it always
 * has, and a hydrated message that the turn leaves alone is saved as the stored sealed copy
 * (`saveConversationMessages` keeps a message whose content this request did not change).
 *
 * Every sealed message must be in the post, not only the branch being answered: the turn may touch any
 * of them (a parent gains a child), and a message it cannot read it cannot reseal.
 *
 * Returns the MACs that matched under an old key or in the unsalted form, each re-taken under the active
 * key (`restampSealedMacs` stores them), or null when there are none.
 *
 * @throws SealedHistoryError when the post leaves a sealed message out, names one that is not sealed,
 * or carries a body whose MAC does not match.
 */
export function hydrateSealedHistory(
	conv: HistoryConversation,
	conversationId: string,
	posted: { history?: TurnHistoryEntry[]; preprompt?: TurnPreprompt }
): MacRestamps | null {
	const sealed = conv.messages.filter((m) => m.sealed);
	const history = posted.history ?? [];
	if (sealed.length === 0 && !conv.sealedPreprompt) {
		if (history.length || posted.preprompt) {
			throw new SealedHistoryError("history_unexpected", "history was sent for a conversation with nothing sealed");
		}
		return null;
	}
	const ring = requireMacRingToCheck();
	const restamps: MacRestamps = { messages: [] };
	const byId = new Map<string, TurnHistoryEntry>();
	for (const h of history) {
		if (byId.has(h.id)) throw new SealedHistoryError("history_unexpected", "history names a message twice");
		byId.set(h.id, h);
	}
	const sealedIds = new Set(sealed.map((m) => m.id));
	for (const id of byId.keys()) {
		if (!sealedIds.has(id)) throw new SealedHistoryError("history_unexpected", "history names a message that is not sealed here");
	}
	conv.messages = conv.messages.map((m) => {
		if (!m.sealed) return m;
		const h = byId.get(m.id);
		if (!h) throw new SealedHistoryError("history_missing", "unlock this chat to continue it: a sealed message was not sent");
		return checkedJoin(ring, m, conversationId, h, restamps);
	});
	if (conv.sealedPreprompt) {
		const p = posted.preprompt;
		if (!p) throw new SealedHistoryError("history_missing", "unlock this chat to continue it: its instructions were not sent");
		const slot = { kind: "preprompt" as const, conversationId, rev: p.rev };
		const checked = p.rev === conv.sealedPrepromptRev ? checkMac(ring, slot, p.text, p.salt, conv.sealedPrepromptMac) : { ok: false as const };
		if (!checked.ok) {
			throw new SealedHistoryError("history_mismatch", "the instructions sent do not match this chat as stored");
		}
		if (checked.restamp) restamps.preprompt = { rev: p.rev, sealedPrepromptMac: checked.restamp };
		conv.preprompt = p.text;
	} else if (posted.preprompt) {
		throw new SealedHistoryError("history_unexpected", "instructions were sent for a chat whose instructions are not sealed");
	}
	return restamps.messages.length || restamps.preprompt ? restamps : null;
}

/**
 * The HTTP error a refused history becomes on every route that reads one: 503 when this deployment has no
 * MAC key, otherwise 409, with `reason` set to the code so the browser can tell it from another 409 and
 * resync. Throws.
 */
export function sealedHistoryHttpError(e: SealedHistoryError): never {
	error(e.code === "mac_key_missing" ? 503 : 409, { message: e.message, reason: e.code });
}

const postedHistorySchema = chatRequestSchema.pick({ history: true, preprompt: true });

/** The opened history and preprompt a request outside the turn posts, in the turn's own shape. Throws
 *  400 "invalid history" on any other shape. */
export function parsePostedHistory(body: { history?: unknown; preprompt?: unknown } | null | undefined): {
	history?: TurnHistoryEntry[];
	preprompt?: TurnPreprompt;
} {
	const parsed = postedHistorySchema.safeParse({ history: body?.history, preprompt: body?.preprompt });
	if (!parsed.success) error(400, "invalid history");
	return parsed.data;
}

/**
 * For a request outside the turn (share, second opinion, prompt view): parse
 * the posted history, put it into `conv` as `hydrateSealedHistory` does, and turn a refusal into its HTTP
 * error after logging `sealed-history-refused` as "<logTag> history refused".
 */
export function hydratePostedHistory(
	conv: HistoryConversation,
	conversationId: string,
	body: { history?: unknown; preprompt?: unknown } | null | undefined,
	logTag: string
): void {
	const posted = parsePostedHistory(body);
	try {
		hydrateSealedHistory(conv, conversationId, posted);
	} catch (e) {
		if (e instanceof SealedHistoryError) {
			logger.warn({ event: "sealed-history-refused", code: e.code, conversationId }, `${logTag} history refused`);
			sealedHistoryHttpError(e);
		}
		throw e;
	}
}

/** Seals for one owner's conversation. */
export type ConversationSealer = {
	/** The stored form of a message: its skeleton and a new seal at the next revision. `salt` is the
	 *  envelope's MAC salt, fresh when not given; a caller passes one only to hand it back to the browser
	 *  that sent the words (the create route's echo). */
	message(message: Message, salt?: string): Promise<Message>;
	/** The stored form of a title at `rev`. */
	title(text: string, rev: number): Promise<{ sealedTitle: string; sealedTitleRev: number }>;
	/** The stored form of a preprompt at `rev`, with the MAC a turn's posted preprompt must match. `salt`
	 *  as for `message`. */
	preprompt(text: string, rev: number, salt?: string): Promise<SealedPrepromptFields>;
};

/** A sealed preprompt as the conversation row stores it. */
type SealedPrepromptFields = { sealedPreprompt: string; sealedPrepromptRev: number; sealedPrepromptMac: string };

/**
 * The sealer for a conversation's owner, or null when nothing should be sealed: sealing is off here, or
 * the owner has not enrolled a history key.
 *
 * `sealedRow`: the conversation already holds sealed parts. Its writes are sealed even while the switch
 * is off, so a chat once sealed never drifts back to plaintext one turn at a time.
 *
 * @throws SealedHistoryError mac_key_missing with sealing on and no secret.
 * @throws HistoryKeyStoreError key_tombstoned for a deleted account, and whatever the key store throws:
 * the caller's write fails rather than land in plaintext.
 */
export async function conversationSealer(
	conversationId: string,
	owner: { userId?: { toString(): string } | null; sessionId?: string | null },
	opts: { sealedRow?: boolean } = {}
): Promise<ConversationSealer | null> {
	const forOwner = await ownerSealer(owner, { conversationId }, opts);
	return forOwner ? forOwner(conversationId) : null;
}

/**
 * One owner's sealer for any of their conversations, reading their recipient once: for a writer that
 * seals many conversations for one owner, such as the Open WebUI import. Null and throws as
 * `conversationSealer`.
 */
export async function ownerSealer(
	owner: { userId?: { toString(): string } | null; sessionId?: string | null },
	logContext: Record<string, unknown> = {},
	opts: { sealedRow?: boolean } = {}
): Promise<((conversationId: string) => ConversationSealer) | null> {
	if (!conversationSealWritesOn()) {
		if (!opts.sealedRow) return null;
		logger.warn({ event: "history-seal-switch-off-sealed-row", ...logContext }, "[sealed-turn] sealing is off here, but this chat is sealed: sealing its write anyway");
	}
	const userId = owner.userId?.toString();
	// A guest's new chats are written in plaintext, even when the guest holds a device key.
	// Signing in moves a guest's chats to the account (migrateAnonymousSession.ts), and nothing yet
	// hands the guest key over or reseals those chats to the account's key, so a chat sealed to the
	// guest would be locked to the account it now belongs to. A guest chat already sealed keeps sealing
	// its writes, as any sealed row does.
	if (!userId && !opts.sealedRow) return null;
	const ring = requireMacKey();
	const mac = { kid: ring.active, key: ring.keys.get(ring.active)! };
	const grant = userId ? ownerGrant("users", userId) : owner.sessionId ? ownerGrant("guests", owner.sessionId) : null;
	if (!grant) return null;
	if (!custodialStorageConfigured()) {
		logger.error({ event: "history-seal-no-storage", ...logContext }, "[sealed-turn] sealing is on but this deployment has no custodial storage");
		throw new Error(`${HISTORY_SEAL_WRITES_FLAG} is on but this deployment has no custodial storage for history keys`);
	}
	const recipient = await readHistoryRecipient(grant, custodialKeyBucket());
	return recipient ? recipientSealer(recipient, mac) : null;
}

/** Seals to one history recipient, each body MAC'd under `mac` with a fresh salt in its envelope: what
 *  `ownerSealer` returns once it has read the owner's recipient. */
export function recipientSealer(recipient: string, mac: { kid: string; key: Buffer }): (conversationId: string) => ConversationSealer {
	const seal = async (envelope: SealedEnvelope) =>
		Buffer.from(await sealToRecipient(recipient, new TextEncoder().encode(JSON.stringify(envelope)))).toString("base64");
	return (conversationId) => ({
		async message(message, salt = newMacSalt()) {
			const rev = (message.sealedRev ?? -1) + 1;
			const { skeleton, body } = splitMessage(message);
			const slot = { kind: "message" as const, conversationId, messageId: message.id, rev };
			const sealed = await seal({ v: 1, kind: "message", conversationId, messageId: message.id, rev, body, salt });
			return { ...skeleton, sealed, sealedRev: rev, sealedMac: saltedSlotMac(mac.kid, mac.key, slot, body, salt) };
		},
		async title(text, rev) {
			return { sealedTitle: await seal({ v: 1, kind: "title", conversationId, rev, text }), sealedTitleRev: rev };
		},
		async preprompt(text, rev, salt = newMacSalt()) {
			const slot = { kind: "preprompt" as const, conversationId, rev };
			return {
				sealedPreprompt: await seal({ v: 1, kind: "preprompt", conversationId, rev, text, salt }),
				sealedPrepromptRev: rev,
				sealedPrepromptMac: saltedSlotMac(mac.kid, mac.key, slot, text, salt),
			};
		},
	});
}

/**
 * Whether this owner holds their own history key: sealing is on and the key's holder is the
 * person, so the server cannot read their chats. A reader that needs plaintext, such as past-chat search,
 * is off for them. A server-held key does not count: the server can open those chats, so that reader
 * stays on. When the recipient or holder cannot be read, the answer is yes: a reader that wrongly stays
 * on would see only empty skeletons and present that as "nothing found".
 */
export async function ownerHoldsOwnHistoryKey(owner: { userId?: { toString(): string } | null; sessionId?: string | null }): Promise<boolean> {
	if (!conversationSealWritesOn()) return false;
	const userId = owner.userId?.toString();
	// A guest's chats are not written sealed (`ownerSealer`).
	if (!userId) return false;
	const grant = ownerGrant("users", userId);
	if (!custodialStorageConfigured()) return true;
	try {
		const keys = custodialKeyBucket();
		if (!(await readHistoryRecipient(grant, keys))) return false;
		return (await readHistoryHolder(grant, keys)) === "person";
	} catch (err) {
		logger.warn({ event: "history-recipient-unreadable", err: String(err) }, "[sealed-turn] history key unreadable; treating the owner as holding their own key");
		return true;
	}
}

/**
 * A conversation's preprompt sealed in place: the sealed preprompt with `preprompt` blanked, and
 * the root system message, which holds the same text, sealed too. Null when there is nothing to seal: an
 * empty preprompt, or one already sealed. The root message is resealed at its next revision only when it
 * is still plaintext; a sealed one stays as it is. `salts` as for `ConversationSealer.message`.
 */
export async function sealPreprompt(
	sealer: ConversationSealer,
	conv: { preprompt?: string; sealedPreprompt?: string; sealedPrepromptRev?: number; rootMessageId?: string; messages: Message[] },
	salts: { preprompt?: string; root?: string } = {}
): Promise<{ fields: SealedPrepromptFields & { preprompt: "" }; root?: Message } | null> {
	if (conv.sealedPreprompt || !conv.preprompt) return null;
	const fields = { preprompt: "" as const, ...(await sealer.preprompt(conv.preprompt, (conv.sealedPrepromptRev ?? -1) + 1, salts.preprompt)) };
	const root = conv.messages.find((m) => m.id === conv.rootMessageId && m.from === "system" && !m.sealed && m.content);
	return { fields, ...(root ? { root: await sealer.message(root, salts.root) } : {}) };
}

/**
 * The update that sets a conversation's title: sealed to the owner, with the plaintext `title` blanked,
 * while sealing is on and the owner has a key, or the title is already sealed; otherwise the
 * plaintext title, with any sealed title cleared, since a stored `sealedTitle` wins over `title` in the
 * browser.
 */
export async function titleUpdate(
	conversationId: string,
	conv: {
		userId?: { toString(): string } | null;
		sessionId?: string | null;
		sealedTitle?: string;
		sealedTitleRev?: number;
		sealedPreprompt?: string;
		messages?: Message[];
	},
	title: string
): Promise<{ $set: Record<string, unknown>; $unset?: Record<string, unknown> }> {
	const sealer = await conversationSealer(conversationId, conv, { sealedRow: rowHasSealedParts(conv) });
	if (!sealer) return conv.sealedTitle ? { $set: { title }, $unset: { sealedTitle: "", sealedTitleRev: "" } } : { $set: { title } };
	return { $set: { title: "", ...(await sealer.title(title, (conv.sealedTitleRev ?? -1) + 1)) } };
}
