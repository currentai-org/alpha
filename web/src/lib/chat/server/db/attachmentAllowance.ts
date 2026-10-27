/**
 * The rolling 24-hour allowance on chat attachments, per account or guest session. Each
 * stored attachment inserts one `message_events` row carrying its size, whichever store took it (the
 * bucket, a linked location or the files table), so the files table stops being storage with no limit
 * when the bucket refuses or stalls. The composer reads what is left when a file is attached
 * (`GET /chat/api/attachment-allowance`), and parseRequest checks again at send.
 *
 * Counting always runs; REFUSING is behind the `attachment-allowance` flag (CUR-3600), so a wrong number
 * can be relaxed in PostHog without a deploy. With the flag off, a file past the allowance is logged as
 * `would refuse` and stored, which is the measurement the production decision is made from.
 *
 * FAILS OPEN, like the other `message_events` limits: a database error reads as no count, and the
 * turn goes on. The files table lives in that same database, so a failure that hides the count also
 * stops the writes it would have bounded. (CUR-3235)
 */
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger.js";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { ATTACHMENT_ALLOWANCE, ATTACHMENT_ALLOWANCE_WINDOW_MS } from "$lib/chat/constants/uploadLimits";

const TYPE = "chatAttachment";

/** PostHog flag key. Account-scoped: a signed-in visitor reads their account's answer, a guest the
 *  deployment's. Off when PostHog has never answered, so a new limit never refuses by accident. */
export const ATTACHMENT_ALLOWANCE_FLAG = "attachment-allowance";

/** Does a file past the allowance get refused, or only logged? */
export function attachmentAllowanceEnforced(): boolean {
	return flagEnabledOr(ATTACHMENT_ALLOWANCE_FLAG, () => false);
}

/** Whose allowance: an account by user id, a guest by session id. A guest also carries the network's
 *  hashed address (`hashIp(…, "rate-limit")`, the key chat's own per-network ceiling counts by), when
 *  the deployment has a pepper to hash it with. */
export type AttachmentOwner = { userId: string } | { guestSessionId: string; ipHash?: string };

/** What the owner can still attach, and when the oldest counted file stops counting. `network`: the
 *  guests on this network, not this session, are what ran out. */
export type AttachmentAllowanceLeft = { files: number; bytes: number; resetsAt?: Date; network?: true };

type CountedRow = { bytes?: number; expiresAt: Date };

const ownerKey = (owner: AttachmentOwner) => ({
	type: TYPE,
	userId: "userId" in owner ? owner.userId : owner.guestSessionId,
});

/** What `rows` leave of `limit`. */
function leftOf(rows: CountedRow[], limit: { files: number; bytes: number }): AttachmentAllowanceLeft {
	const used = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
	const oldest = rows.reduce<Date | undefined>(
		(min, r) => (min === undefined || new Date(r.expiresAt) < min ? new Date(r.expiresAt) : min),
		undefined
	);
	return {
		files: Math.max(0, limit.files - rows.length),
		bytes: Math.max(0, limit.bytes - used),
		...(oldest ? { resetsAt: oldest } : {}),
	};
}

/** The owner's allowance left, or null when the count failed. A guest with a network gets the tighter
 *  of their session's allowance and what the network's guests have left between them. */
export async function attachmentAllowanceLeft(owner: AttachmentOwner): Promise<AttachmentAllowanceLeft | null> {
	const live = { expiresAt: { $gt: new Date() } };
	const ipHash = "guestSessionId" in owner ? owner.ipHash : undefined;
	let rows: CountedRow[];
	let networkRows: CountedRow[] | undefined;
	try {
		[rows, networkRows] = await Promise.all([
			collections.messageEvents.find({ ...ownerKey(owner), ...live }).toArray(),
			ipHash ? collections.messageEvents.find({ type: TYPE, ipHash, ...live }).toArray() : undefined,
		]);
	} catch (e) {
		logger.warn(e, "[attachment-allowance] count failed — the attachment is allowed");
		return null;
	}
	if ("userId" in owner) return leftOf(rows, ATTACHMENT_ALLOWANCE.account);
	const session = leftOf(rows, ATTACHMENT_ALLOWANCE.guest);
	if (!networkRows) return session;
	const network = leftOf(networkRows, ATTACHMENT_ALLOWANCE.guestNetwork);
	// Each dimension takes the tighter side on its own: picking one side whole would let its looser
	// limit through.
	const networkBinds = network.files < session.files || network.bytes < session.bytes;
	if (!networkBinds) return session;
	const sessionBinds = session.files < network.files || session.bytes < network.bytes;
	// When both sides bind, room frees only once the later of the two resets.
	const resets = [network.resetsAt, sessionBinds ? session.resetsAt : undefined].filter((d): d is Date => !!d);
	const resetsAt = resets.length ? new Date(Math.max(...resets.map((d) => d.getTime()))) : undefined;
	return {
		files: Math.min(session.files, network.files),
		bytes: Math.min(session.bytes, network.bytes),
		...(resetsAt ? { resetsAt } : {}),
		network: true,
	};
}

/** True when `sizes` fit in what is left. A failed count (null) lets them through. */
export function fitsAllowance(left: AttachmentAllowanceLeft | null, sizes: readonly number[]): boolean {
	if (!left || sizes.length === 0) return true;
	return sizes.length <= left.files && sizes.reduce((a, b) => a + b, 0) <= left.bytes;
}

/** Count stored attachments against the owner's allowance. Never throws. */
export async function recordAttachments(owner: AttachmentOwner, sizes: readonly number[]): Promise<void> {
	const now = Date.now();
	for (const bytes of sizes) {
		try {
			await collections.messageEvents.insertOne({
				...ownerKey(owner),
				...("guestSessionId" in owner && owner.ipHash ? { ipHash: owner.ipHash } : {}),
				bytes,
				createdAt: new Date(now),
				expiresAt: new Date(now + ATTACHMENT_ALLOWANCE_WINDOW_MS),
			});
		} catch (e) {
			logger.warn(e, "[attachment-allowance] failed to record — continuing");
			return;
		}
	}
}
