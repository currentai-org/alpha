/**
 * The run-code history a usage tier is read from, in chat's own database.
 *
 * One `message_events` row per sandbox call that ran (run_code, run_command, write_file), keyed by the
 * account and carrying the conversation id. Each row lives for the tier table's history window, so the
 * same rows answer three questions: how many runs today (rows from the last 24 hours), which
 * conversations hold a live sandbox (rows from the last idle window), and how much clean use the
 * account has behind it (every row still alive). `cleanup.ts` deletes a row once it expires, and
 * account deletion takes them with every other `message_events` row (`wipeUserData.ts`).
 *
 * agent-service holds no credential for this database, and keeps its own ceiling of two live
 * sandboxes per account (`E2B_ACCOUNT_MAX_LIVE`), so a read that fails here costs a few extra runs and
 * nothing more. Every function throws on a database error; `sandboxAllowance.ts` decides what that means. (CUR-4578)
 */
import { collections } from "$lib/chat/server/database";
import { accountDeclinedSince } from "$lib/chat/server/db/safetyEvents";

const TYPE = "sandboxRun";

export type RecentRun = { createdAt: Date; conversationId?: string };
export type RunHistory = { runs: number; firstRunAt: Date | null; declined: boolean };

/** Where the gate reads and writes. Injected in the spec. */
export interface SandboxRunStore {
	/** Runs still inside the history window, the oldest one's time, and whether a real safety decline
	 *  landed on the account since `declineSince`. */
	history(userId: string, declineSince: Date): Promise<RunHistory>;
	/** Runs since `since`, oldest first. */
	recent(userId: string, since: Date): Promise<RecentRun[]>;
	record(userId: string, conversationId: string, keepMs: number): Promise<void>;
}

export const dbSandboxRunStore: SandboxRunStore = {
	async history(userId, declineSince) {
		const live = { type: TYPE, userId, expiresAt: { $gt: new Date() } };
		const [runs, first, declined] = await Promise.all([
			collections.messageEvents.countDocuments(live),
			collections.messageEvents.find(live).sort({ createdAt: 1 }).limit(1).toArray(),
			accountDeclinedSince(userId, declineSince),
		]);
		return { runs, firstRunAt: first[0]?.createdAt ? new Date(first[0].createdAt) : null, declined };
	},
	async recent(userId, since) {
		const rows = await collections.messageEvents
			.find({ type: TYPE, userId, createdAt: { $gt: since } })
			.sort({ createdAt: 1 })
			.toArray();
		return rows.map((r) => ({ createdAt: new Date(r.createdAt), conversationId: r.conversationId }));
	},
	async record(userId, conversationId, keepMs) {
		const createdAt = new Date();
		await collections.messageEvents.insertOne({
			type: TYPE,
			userId,
			conversationId,
			createdAt,
			expiresAt: new Date(createdAt.getTime() + keepMs),
		});
	},
};
