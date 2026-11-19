import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { logger } from "$lib/chat/server/logger";
import { ownerGrant, type Grant } from "$lib/chat/server/storage/custodialCrypto";
import { custodialKeyBucket, custodialStorageConfigured } from "$lib/chat/server/storage/custodialStorage";
import { custodialStorageForGuestsEnabled } from "$lib/chat/server/storage/custodialStorageGate";
import { withAdvisoryLock } from "$lib/chat/server/db/advisoryLock";
import { allowanceRoom, recordEvent } from "$lib/chat/server/db/eventWindow";
import {
	HISTORY_KEY_MAX_BYTES,
	HistoryKeyStoreError,
	readHistoryKey,
	readHistoryKeyGeneration,
	storeHistoryKey,
} from "$lib/chat/server/storage/historyKey";
import { conversationSealWritesOn } from "$lib/chat/server/chat/sealedTurn";
import { sealOwnerHistory } from "$lib/chat/server/chat/sealBackfill";

// The caller's own wrapped conversation-history key (stage 1). The browser makes
// and wraps the key; this route only keeps it.
//
// The owner is the session's, always: there is no parameter naming whose key to read or write, so no
// request can reach another person's file. A deployment with no custodial storage answers 503 and logs
// it, because a browser told "stored" here would believe its history could be sealed.
//
// Every wrap stored is kept as a generation: GET lists the older ones, and
// `GET ?generation=<id>` serves one, so a browser whose newest wrap will not open can try the ones
// before it. PUTs are limited per owner, since each one adds a generation.

/** Stores per owner per REWRAP_WINDOW_MS. A person adds or removes a way in a few times in a day at most. */
const HISTORY_KEY_PUTS_PER_WINDOW = 10;
const REWRAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const REWRAP_EVENT = "historyKeyPut";
/** The wrap format a PUT must declare: every way in, plus the history identity's own recipient. */
const WRAP_FORMAT = 2;

/** The session's own owner: the signed-in account, else the guest session where guests may store. */
function sessionOwner(locals: App.Locals): Grant {
	const userId = locals.user?._id?.toString();
	if (userId) return ownerGrant("users", userId);
	if (locals.sessionId && custodialStorageForGuestsEnabled()) return ownerGrant("guests", locals.sessionId);
	error(401, "Sign in to keep a history key");
}

function requireStorage(method: string): void {
	if (custodialStorageConfigured()) return;
	logger.error({ event: "history-key-no-storage", method }, "[history-key] no custodial storage on this deployment: history keys cannot be kept");
	error(503, "This deployment has no storage for history keys");
}

function statusFor(e: HistoryKeyStoreError): number {
	if (e.code === "key_tombstoned") return 410;
	if (e.code === "recipient_changed" || e.code === "stale_wrap") return 409;
	return 400;
}

const NO_STORE = { "cache-control": "no-store" };

/** The largest PUT body: a maximal wrap in base64 (4/3 its size), a hybrid recipient (~2 KB), a hash and
 *  the JSON around them. */
const MAX_BODY_BYTES = Math.ceil((HISTORY_KEY_MAX_BYTES * 4) / 3) + 4 * 1024;

/** The request body as text, refused at MAX_BODY_BYTES whatever `content-length` claimed, so nothing
 *  larger is buffered or parsed. */
async function cappedText(request: Request): Promise<string> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) error(413, "The history key body is too large");
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			error(413, "The history key body is too large");
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * An account that has just turned encryption on gets its existing chats that are not sealed
 * to that key sealed to it, with public keys only. Nothing is deleted. A failure leaves those chats readable as they
 * were and is logged; the deployment's backfill (`scripts/seal-history-backfill.ts`) takes them later.
 * Guests are left as they are: their device key is made silently and is out of this change's scope.
 * The answer tells the browser which happened, so it never says chats are sealed when they are not.
 * It runs after the key's lock is released, and inline so the answer is true when the dialog closes.
 */
async function sealExistingHistory(locals: App.Locals): Promise<"sealed" | "not_sealed" | undefined> {
	const userId = locals.user?._id?.toString();
	if (!userId) return undefined;
	if (!conversationSealWritesOn()) return "not_sealed";
	const started = Date.now();
	try {
		const report = await sealOwnerHistory(userId);
		logger.info(
			{ event: "history-key-opt-in-sealed", conversations: report.sealed.conversations, messages: report.sealed.messages, changedMeanwhile: report.changedMeanwhile, ms: Date.now() - started },
			"[history-key] sealed the account's existing chats to its new key"
		);
		return "sealed";
	} catch (e) {
		logger.error({ event: "history-key-opt-in-seal-failed", err: e, ms: Date.now() - started }, "[history-key] could not seal the account's existing chats; they stay as they were");
		return "not_sealed";
	}
}

export const GET: RequestHandler = async ({ locals, url }) => {
	const grant = sessionOwner(locals);
	requireStorage("GET");
	const generation = url.searchParams.get("generation");
	try {
		if (generation !== null) {
			const older = await readHistoryKeyGeneration(grant, custodialKeyBucket(), generation);
			if (!older) error(404, "No such history key generation");
			return json(
				{ wrapped: Buffer.from(older.wrapped).toString("base64"), recipient: older.recipient, hash: older.hash, id: generation },
				{ headers: NO_STORE }
			);
		}
		const stored = await readHistoryKey(grant, custodialKeyBucket());
		if (!stored) error(404, "No history key yet");
		return json(
			{ wrapped: Buffer.from(stored.wrapped).toString("base64"), recipient: stored.recipient, hash: stored.hash, generations: stored.generations },
			{ headers: NO_STORE }
		);
	} catch (e) {
		if (e instanceof HistoryKeyStoreError) error(statusFor(e), e.message);
		throw e;
	}
};

/** The owner's PUT allowance, counted in message_events like every database-backed limit. A failed
 *  count lets the PUT through (eventWindow.ts fails open): every generation is kept either way, so the
 *  limit bounds how many a stolen session adds, not whether the owner's wrap survives. */
async function requirePutRoom(grant: Grant): Promise<void> {
	const room = await allowanceRoom({ type: REWRAP_EVENT, userId: `${grant.root}:${grant.id}` }, HISTORY_KEY_PUTS_PER_WINDOW, "history-key-put-rate");
	if (room.ok) return;
	logger.warn({ event: "history-key-put-limited", root: grant.root }, "[history-key] PUT refused: the owner's limit is reached");
	error(429, `Too many history key changes; try again in ${room.retryAfterSecs ?? REWRAP_WINDOW_MS / 1000} seconds`);
}

export const PUT: RequestHandler = async ({ locals, request }) => {
	const grant = sessionOwner(locals);
	requireStorage("PUT");
	await requirePutRoom(grant);
	const text = await cappedText(request);
	let body: { wrapped?: unknown; recipient?: unknown; replaces?: unknown; format?: unknown } | null = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	if (!body || typeof body.wrapped !== "string" || typeof body.recipient !== "string" || (body.replaces !== undefined && typeof body.replaces !== "string")) {
		error(400, "Expected { wrapped: base64, recipient: string, replaces?: string, format: 2 }");
	}
	// Only a browser that adds the identity's own stanza to every wrap may store one: the
	// unlock fallback tells a removal a person made from junk by that stanza, so a stored wrap without it
	// that a person made would let a removed way in back in. A tab still running the older bundle is
	// refused here, and reloading fixes it.
	if (body.format !== WRAP_FORMAT) error(400, "This page is out of date: reload it to change your history key");
	const wrapped = new Uint8Array(Buffer.from(body.wrapped, "base64"));
	try {
		const { created } = await storeHistoryKey(grant, custodialKeyBucket(), withAdvisoryLock, {
			wrapped,
			recipient: body.recipient,
			replaces: body.replaces as string | undefined,
		});
		await recordEvent({ type: REWRAP_EVENT, userId: `${grant.root}:${grant.id}` }, REWRAP_WINDOW_MS, "history-key-put-rate");
		const existingChats = created ? await sealExistingHistory(locals) : undefined;
		return json({ created, existingChats }, { status: created ? 201 : 200, headers: NO_STORE });
	} catch (e) {
		if (e instanceof HistoryKeyStoreError) error(statusFor(e), e.message);
		throw e;
	}
};
