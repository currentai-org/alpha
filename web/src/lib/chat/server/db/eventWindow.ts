/**
 * The one counting mechanism every database-backed rate limit shares. A limited action
 * inserts a `message_events` row whose `expiresAt` is now + its window; "recent" is a count of the
 * key's unexpired rows. Rows expire one at a time, so each limit is a sliding window rather than a
 * fixed bucket. The (ip_hash, type, expires_at) and (user_id, type, expires_at) indexes serve the
 * counts, and `cleanup.ts` deletes expired rows.
 *
 * Callers pass keys that are already hashed (`hashIp`, `hashTargetEmail`) or opaque session ids, so
 * no raw IP or email reaches this table.
 *
 * Every function here FAILS OPEN and logs under the caller's label: a database error makes a count
 * read as `null` and a write a no-op. Each caller decides what `null` means. The chat daily cap in
 * chat/rateLimit.ts refuses on it; every other caller allows the request.
 */
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger.js";
import type { MessageEvent } from "$lib/chat/types/MessageEvent";

/** Which rows count together. `type` separates limits that share a key column. */
// A type alias, not an interface, so it satisfies the collection's index-signature `Filter`.
export type EventKey = {
	type: string;
	ipHash?: string;
	userId?: MessageEvent["userId"];
};

/** Unexpired rows for this key, or `null` when the count failed. */
export async function countLiveEvents(key: EventKey, label: string): Promise<number | null> {
	try {
		return await collections.messageEvents.countDocuments({
			...key,
			expiresAt: { $gt: new Date() },
		});
	} catch (e) {
		logger.warn(e, `[${label}] count failed — the caller decides whether to allow`);
		return null;
	}
}

/** How long until one more event fits under `max`, given the expiries of the key's live rows: the
 *  next one is allowed once at most `max - 1` remain, so the wait is the expiry of the row that has
 *  to go for that, counted from the earliest. 0 when there is room now. */
function msUntilRoom(expiries: readonly Date[], max: number, now = Date.now()): number {
	const live = expiries.map((d) => new Date(d).getTime()).filter((t) => t > now).sort((a, b) => a - b);
	const mustExpire = live.length - max + 1;
	if (mustExpire <= 0) return 0;
	return live[mustExpire - 1] - now;
}

/** Seconds until one more event fits under `max` for this key, rounded up, or `null` when the read
 *  failed. */
export async function secondsUntilRoom(key: EventKey, max: number, label: string): Promise<number | null> {
	try {
		const now = Date.now();
		const rows = await collections.messageEvents.find({ ...key, expiresAt: { $gt: new Date(now) } }).toArray();
		return Math.ceil(msUntilRoom(rows.map((r) => r.expiresAt), max, now) / 1000);
	} catch (e) {
		logger.warn(e, `[${label}] wait read failed — the refusal goes out without one`);
		return null;
	}
}

/** A daily allowance's verdict for this key: `{ ok: true }` while it has fewer than `max` live rows (or
 *  the count failed, so every allowance built on it fails open); otherwise how many seconds until the
 *  oldest counted row stops counting, `null` when that could not be read. Shared by the agent-task and
 *  chat-turn allowances. */
export async function allowanceRoom(
	key: EventKey,
	max: number,
	label: string
): Promise<{ ok: true } | { ok: false; retryAfterSecs: number | null }> {
	const used = await countLiveEvents(key, label);
	if (used === null || used < max) return { ok: true };
	return { ok: false, retryAfterSecs: await secondsUntilRoom(key, max, label) };
}

/** True while the key has fewer than `max` unexpired rows, and on a failed count. */
export async function underEventLimit(key: EventKey, max: number, label: string): Promise<boolean> {
	const recent = await countLiveEvents(key, label);
	return recent === null || recent < max;
}

/** Record one event that counts against `key` for `windowMs`. Never throws. */
export async function recordEvent(key: EventKey, windowMs: number, label: string): Promise<void> {
	try {
		const createdAt = new Date();
		await collections.messageEvents.insertOne({
			...key,
			createdAt,
			expiresAt: new Date(createdAt.getTime() + windowMs),
		});
	} catch (e) {
		logger.warn(e, `[${label}] failed to record event — continuing`);
	}
}

/** Record `count` events against `key` in one write, for an action that costs more than one. Never throws. */
export async function recordEvents(key: EventKey, count: number, windowMs: number, label: string): Promise<void> {
	if (count <= 0) return;
	const createdAt = new Date();
	const expiresAt = new Date(createdAt.getTime() + windowMs);
	try {
		await collections.messageEvents.insertMany(Array.from({ length: count }, () => ({ ...key, createdAt, expiresAt })));
	} catch (e) {
		logger.warn(e, `[${label}] failed to record events — continuing`);
	}
}

/** Drop every row for `key`, as a successful login does for its failures. Never throws. */
export async function clearEvents(key: EventKey, label: string): Promise<void> {
	try {
		await collections.messageEvents.deleteMany(key);
	} catch (e) {
		logger.warn(e, `[${label}] failed to clear events — continuing`);
	}
}
