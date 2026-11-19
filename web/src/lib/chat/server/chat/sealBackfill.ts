// The conversation history seal backfill: seal the conversations written
// before the history-seal-writes flag went on, and count what is still plaintext.
//
// The backfill seals with public keys only, through the turn path's own sealer (`ownerSealer`, so each
// message gets the same skeleton, envelope and `sealedMac` a turn writes, and each title the same
// `sealedTitle`). An owner with no history recipient is counted and skipped: there is nothing to seal to.
//
// A plaintext `preprompt` is sealed with its conversation, through the write path's own `sealPreprompt`,
// with the root system message that repeats it. Sealing only the root message would leave the
// same words in plaintext in `preprompt`. GET /chat/api/v2/conversations/[id] returns `sealedPreprompt`
// to every owner, so the browser can post it back on the next turn.
//
// Every number here is aggregate. Nothing returns a conversation's text, title, id or owner.

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import {
	canonicalJson,
	conversationSealWritesOn,
	HISTORY_SEAL_WRITES_FLAG,
	ownerSealer,
	requireMacKey,
	SealedHistoryError,
	sealPreprompt,
	type ConversationSealer,
} from "$lib/chat/server/chat/sealedTurn";
import { ensureFlagsPolled } from "$lib/chat/server/flags";
import { custodialBackend } from "$lib/chat/server/storage/custodialBackend";
import { historyRecipientOwners } from "$lib/chat/server/storage/historyKey";
import type { Message } from "$lib/chat/types/Message";

const doc = schema.conversations.doc;
/** The stored messages as a JSON array, whatever the row holds. */
const messagesArray = sql`case when jsonb_typeof(${doc}->'messages') = 'array' then ${doc}->'messages' else '[]'::jsonb end`;
/**
 * A message not yet sealed to its owner's history key, which the backfill and the opt-in seal
 * take. Today that is a message with no seal, whose words sit in the row. This predicate and
 * `sealedToOwnerKey` below are the one place that decides it, so another kind of unsealed message
 * (one sealed to the server-held custodial key, say) is added here rather than in each caller.
 */
const unsealedMessage = sql`coalesce(m->>'sealed', '') = ''`;

/** The row-level twin of `unsealedMessage`: whether a read message is already sealed to the owner's key. */
const sealedToOwnerKey = (m: Message): boolean => Boolean(m.sealed);
const unsealedMessages = sql<number>`(select count(*) from jsonb_array_elements(${messagesArray}) m where ${unsealedMessage})`;
const plaintextTitle = sql`coalesce(${doc}->>'title', '') <> ''`;
const plaintextPreprompt = sql`coalesce(${doc}->>'preprompt', '') <> '' and coalesce(${doc}->>'sealedPreprompt', '') = ''`;

/** What is still plaintext in `conversations`, counted across every row. */
export type UnsealedCounts = {
	/** Messages with no `sealed` field. */
	messages: number;
	/** Conversations holding at least one such message or a plaintext title. */
	conversations: number;
	/** Conversations whose `title` is not empty. */
	titles: number;
	/** Conversations whose `preprompt` is not empty and not sealed (the backfill leaves these). */
	preprompts: number;
};

/** The unsealed-history count a daily job reads. One aggregate query; reads no text out. */
export async function countUnsealed(): Promise<UnsealedCounts> {
	const [row] = await getDb()
		.select({
			messages: sql<number>`coalesce(sum(${unsealedMessages}), 0)::int`,
			conversations: sql<number>`(count(*) filter (where ${unsealedMessages} > 0 or ${plaintextTitle}))::int`,
			titles: sql<number>`(count(*) filter (where ${plaintextTitle}))::int`,
			preprompts: sql<number>`(count(*) filter (where ${plaintextPreprompt}))::int`,
		})
		.from(schema.conversations);
	return { messages: row?.messages ?? 0, conversations: row?.conversations ?? 0, titles: row?.titles ?? 0, preprompts: row?.preprompts ?? 0 };
}

type Owner = { userId?: { toString(): string } | null; sessionId?: string | null };
type OwnerSealerFn = (owner: Owner) => Promise<((conversationId: string) => ConversationSealer) | null>;

/** Where a run has got to, after each page: counts only. */
type BackfillProgress = {
	/** Conversations read so far. */
	scanned: number;
	/** Distinct owners whose recipient is resolved so far. */
	owners: number;
	/** Owners the recipient listing found, or null when the run reads every owner's recipient. */
	listed: number | null;
	elapsedMs: number;
};

export type BackfillOptions = {
	/** Seal and write. Without it the run reads and counts only. */
	write?: boolean;
	/** Conversations read per page. */
	batchSize?: number;
	/** Owner recipients read at once. */
	ownerConcurrency?: number;
	/** Injected in specs; production reads the deployment's switch. */
	sealWritesOn?: () => boolean;
	/** Injected in specs; production reads the owner's recipient from custodial storage. */
	sealerFor?: OwnerSealerFn;
	/**
	 * The owners holding a history recipient object, as `users:<id>` / `guests:<id>`, from one listing
	 * (`historyRecipientOwners`). An owner not in it is counted as having no recipient without a read.
	 * Null reads every owner's recipient. Defaults to the custodial bucket's listing in production, and to
	 * null when `sealerFor` is injected.
	 */
	recipientOwners?: (() => Promise<ReadonlySet<string>>) | null;
	/** Throws SealedHistoryError mac_key_missing when the deployment has no MAC key. Checked before any
	 *  read, so a run with no enrolled owner still refuses. Defaults to the real check in production. */
	checkMacKey?: (() => void) | null;
	/** Called after each page, for a progress line. */
	onProgress?: (p: BackfillProgress) => void;
	/** Read only this account's conversations: the run after one person turns encryption on.
	 *  Unset reads every owner's. */
	onlyUserId?: string;
};

type Tally = { owners: number; conversations: number; messages: number; titles: number };
const tally = (): Tally => ({ owners: 0, conversations: 0, messages: 0, titles: 0 });

export type BackfillReport = {
	write: boolean;
	/** Conversations that held an unsealed message or a plaintext title when read. */
	scanned: number;
	/** Sealed by this run, or, in a dry run, what a write would seal. */
	sealed: Tally;
	/** Owners with no history recipient: counted, their rows untouched. */
	noRecipient: Tally;
	/** Rows with neither a user nor a session: nobody to seal to. */
	noOwner: Tally;
	/** Owners whose recipient could not be read (a deleted account's tombstone, a store error): untouched. */
	ownerErrors: Tally;
	/** Messages or titles another write changed between this run's read and its write; the next run takes them. */
	changedMeanwhile: number;
	/** Plaintext preprompts among the scanned rows still plaintext after the run: every one in a dry run,
	 *  and in a write only those whose owner has no key or whose row changed meanwhile. */
	prepromptsLeft: number;
};

/** The error that stops a run: sealing is off for this deployment, or it has no MAC key. */
export class BackfillRefused extends Error {
	override name = "BackfillRefused";
}

const fingerprint = (m: Message) => canonicalJson(m);

/** The custodial bucket's history recipients, from one listing per owner root. */
async function listCustodialRecipients(): Promise<ReadonlySet<string>> {
	const backend = await custodialBackend();
	return historyRecipientOwners((prefix) => backend.list(prefix));
}

/** Run `fn` over `items`, at most `limit` at once. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const refusedForMacKey = (e: unknown) => e instanceof SealedHistoryError && e.code === "mac_key_missing";

/**
 * Seal every conversation still holding a plaintext message or title, for each owner with a history
 * recipient. Dry by default. Idempotent: what it sealed no longer matches, so a second run
 * finds only the rows it skipped.
 *
 * Owners are resolved once each, a page at a time and `ownerConcurrency` at once. In production one
 * listing of the bucket's recipient objects comes first, so only an owner who has one costs a read; a
 * listing that fails falls back to reading every owner. Counts come from SQL; a conversation's
 * document is read only to seal it.
 *
 * Each conversation is sealed from one read and written under the row's lock, message by message: a
 * message or title another request changed since the read is left for the next run, so a turn landing
 * mid-run loses nothing.
 *
 * @throws BackfillRefused when sealing is off here or the deployment has no history MAC key.
 */
export async function runSealBackfill(opts: BackfillOptions = {}): Promise<BackfillReport> {
	// A script reads the deployment's answer, so wait for PostHog's first answer rather than the off fallback.
	if (!opts.sealWritesOn) await ensureFlagsPolled();
	if (!(opts.sealWritesOn ?? conversationSealWritesOn)()) {
		throw new BackfillRefused(`${HISTORY_SEAL_WRITES_FLAG} is off for this deployment; the backfill seals only where turns are sealed`);
	}
	const injected = opts.sealerFor !== undefined;
	const checkMacKey = opts.checkMacKey !== undefined ? opts.checkMacKey : injected ? null : requireMacKey;
	try {
		checkMacKey?.();
	} catch (e) {
		if (refusedForMacKey(e)) throw new BackfillRefused((e as Error).message);
		throw e;
	}
	const sealerFor = opts.sealerFor ?? ownerSealer;
	const listRecipients = opts.recipientOwners !== undefined ? opts.recipientOwners : injected ? null : listCustodialRecipients;
	const write = Boolean(opts.write);
	const batchSize = opts.batchSize ?? 200;
	const concurrency = Math.max(1, opts.ownerConcurrency ?? 16);
	const started = Date.now();
	const report: BackfillReport = {
		write,
		scanned: 0,
		sealed: tally(),
		noRecipient: tally(),
		noOwner: tally(),
		ownerErrors: tally(),
		changedMeanwhile: 0,
		prepromptsLeft: 0,
	};

	// A failed listing costs speed, never a wrong count: every owner is then read one by one.
	let listed: ReadonlySet<string> | null = null;
	if (listRecipients) {
		try {
			listed = await listRecipients();
		} catch {
			listed = null;
		}
	}

	type OwnerState = { kind: "sealed"; sealer: (id: string) => ConversationSealer } | { kind: "noRecipient" | "error" };
	const owners = new Map<string, OwnerState>();
	const settle = (key: string, state: OwnerState) => {
		owners.set(key, state);
		const bucket = state.kind === "sealed" ? report.sealed : state.kind === "noRecipient" ? report.noRecipient : report.ownerErrors;
		bucket.owners += 1;
	};
	const resolveOwner = async (key: string, owner: Owner) => {
		if (listed && !listed.has(key)) return settle(key, { kind: "noRecipient" });
		let state: OwnerState;
		try {
			const sealer = await sealerFor(owner);
			state = sealer ? { kind: "sealed", sealer } : { kind: "noRecipient" };
		} catch (e) {
			if (refusedForMacKey(e)) throw new BackfillRefused((e as Error).message);
			state = { kind: "error" };
		}
		settle(key, state);
	};
	const ownerKeyOf = (row: { userId: string | null; sessionId: string | null }) =>
		row.userId ? `users:${row.userId}` : row.sessionId ? `guests:${row.sessionId}` : null;

	let after = "";
	for (;;) {
		const page = await getDb()
			.select({
				id: schema.conversations.id,
				userId: schema.conversations.userId,
				sessionId: schema.conversations.sessionId,
				preprompt: sql<boolean>`${plaintextPreprompt}`,
				messages: sql<number>`${unsealedMessages}::int`,
				title: sql<boolean>`${plaintextTitle}`,
			})
			.from(schema.conversations)
			.where(
				and(
					gt(schema.conversations.id, after),
					opts.onlyUserId !== undefined ? eq(schema.conversations.userId, opts.onlyUserId) : undefined,
					sql`(${unsealedMessages} > 0 or ${plaintextTitle} or ${plaintextPreprompt})`
				)
			)
			.orderBy(asc(schema.conversations.id))
			.limit(batchSize);
		if (page.length === 0) break;
		after = page[page.length - 1].id;

		const unresolved = new Map<string, Owner>();
		for (const row of page) {
			const key = ownerKeyOf(row);
			if (key && !owners.has(key) && !unresolved.has(key)) unresolved.set(key, { userId: row.userId, sessionId: row.sessionId });
		}
		await eachLimited([...unresolved], concurrency, ([key, owner]) => resolveOwner(key, owner));

		for (const row of page) {
			const counts = (t: Tally) => {
				t.conversations += 1;
				t.messages += Number(row.messages);
				if (row.title) t.titles += 1;
			};
			const key = ownerKeyOf(row);
			const state = key ? owners.get(key) : undefined;
			if (!state || state.kind !== "sealed" || !write) {
				report.scanned += 1;
				if (row.preprompt) report.prepromptsLeft += 1;
				counts(!state ? report.noOwner : state.kind === "noRecipient" ? report.noRecipient : state.kind === "error" ? report.ownerErrors : report.sealed);
				continue;
			}
			const conv = await collections.conversations.findOne({ _id: new ObjectId(row.id) });
			if (!conv) continue;
			report.scanned += 1;
			const pending = (conv.messages ?? []).filter((m) => !sealedToOwnerKey(m));
			const title = conv.title ? conv.title : null;
			const result = await sealConversation(row.id, conv, pending, title, state.sealer(row.id));
			if (row.preprompt && !result.preprompt) report.prepromptsLeft += 1;
			report.changedMeanwhile += result.skipped;
			if (result.messages > 0 || result.title) {
				report.sealed.conversations += 1;
				report.sealed.messages += result.messages;
				if (result.title) report.sealed.titles += 1;
			}
		}
		opts.onProgress?.({ scanned: report.scanned, owners: owners.size, listed: listed ? listed.size : null, elapsedMs: Date.now() - started });
	}
	return report;
}

/** Seal one conversation's plaintext messages and title from one read, and write each one back only
 *  where the row still holds what was read. */
async function sealConversation(
	id: string,
	conv: {
		messages?: Message[];
		title?: string;
		sealedTitleRev?: number;
		preprompt?: string;
		sealedPreprompt?: string;
		sealedPrepromptRev?: number;
		rootMessageId?: string;
	},
	pending: Message[],
	title: string | null,
	sealer: ConversationSealer
): Promise<{ messages: number; title: boolean; preprompt: boolean; skipped: number }> {
	const sealed = new Map<string, { fp: string; stored: Message }>();
	for (const m of pending) sealed.set(m.id, { fp: fingerprint(m), stored: await sealer.message(m) });
	const titleSeal = title !== null ? await sealer.title(title, (conv.sealedTitleRev ?? -1) + 1) : null;
	// The preprompt, sealed as the write path seals it; its root system message replaces the plain seal.
	const prepromptSeal = await sealPreprompt(sealer, { ...conv, messages: pending });
	if (prepromptSeal?.root) {
		const s = sealed.get(prepromptSeal.root.id);
		if (s) s.stored = prepromptSeal.root;
	}

	let messages = 0;
	let titleDone = false;
	let prepromptDone = false;
	let skipped = 0;
	await collections.conversations.modifyOne({ _id: new ObjectId(id) }, (current) => {
		messages = 0;
		titleDone = false;
		prepromptDone = false;
		skipped = 0;
		const $set: Record<string, unknown> = {};
		// A message deleted since the read is simply gone: nothing to seal, nothing to count.
		const next = (current.messages ?? []).map((m) => {
			const s = sealed.get(m.id);
			if (!s || sealedToOwnerKey(m)) return m;
			if (fingerprint(m) !== s.fp) {
				skipped += 1;
				return m;
			}
			messages += 1;
			return s.stored;
		});
		if (messages > 0) $set.messages = next;
		if (titleSeal) {
			if (current.title === title && (current.sealedTitleRev ?? -1) === (conv.sealedTitleRev ?? -1)) {
				Object.assign($set, { title: "", ...titleSeal });
				titleDone = true;
			} else skipped += 1;
		}
		if (prepromptSeal) {
			// Only with its root message, which repeats the same words, or neither.
			const rootDone = !prepromptSeal.root || next.some((m) => m === prepromptSeal.root);
			if (rootDone && !current.sealedPreprompt && current.preprompt === conv.preprompt) {
				Object.assign($set, prepromptSeal.fields);
				prepromptDone = true;
			} else skipped += 1;
		}
		return Object.keys($set).length ? { $set } : null;
	});
	return { messages, title: titleDone, preprompt: prepromptDone, skipped };
}

/**
 * Seal one account's conversations that are not yet sealed to the history key they just turned on
 * (see `unsealedMessage` for what that covers), with public keys only, as the backfill does
 * for everyone. Nothing is deleted. Reads that account's
 * recipient directly rather than listing the bucket.
 *
 * @throws BackfillRefused when sealing is off here or the deployment has no history MAC key.
 */
export function sealOwnerHistory(userId: string): Promise<BackfillReport> {
	return runSealBackfill({ write: true, onlyUserId: userId, recipientOwners: null });
}

/** The report as lines of counts, for the CLI. Holds no text, title, id or owner. */
export function formatBackfillReport(r: BackfillReport): string {
	const t = (x: Tally) => `${x.owners} owners, ${x.conversations} conversations, ${x.messages} messages, ${x.titles} titles`;
	return [
		`history seal backfill (${r.write ? "write" : "dry run: nothing written"})`,
		`  scanned:            ${r.scanned} conversations with plaintext messages or titles`,
		`  ${r.write ? "sealed:            " : "would seal:        "} ${t(r.sealed)}`,
		`  no recipient:       ${t(r.noRecipient)} (skipped, untouched)`,
		`  no owner:           ${r.noOwner.conversations} conversations, ${r.noOwner.messages} messages (skipped)`,
		`  owner unreadable:   ${t(r.ownerErrors)} (skipped)`,
		`  changed meanwhile:  ${r.changedMeanwhile} messages or titles (left for the next run)`,
		`  preprompts left:    ${r.prepromptsLeft} (plaintext after this run)`,
	].join("\n");
}

/** The unsealed count as one line, for the CLI and a daily job's log. */
export function formatUnsealedCounts(c: UnsealedCounts): string {
	return `unsealed: ${c.messages} messages in ${c.conversations} conversations; ${c.titles} plaintext titles; ${c.preprompts} plaintext preprompts`;
}
