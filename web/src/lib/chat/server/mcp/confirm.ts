// Asking the person before an MCP tool that may change something runs (CUR-3026).
//
// The question is a row in mcpElicitations, the same durable table and answer route the 2026-era
// elicitation flow uses (CUR-1017): POST /chat/conversation/{id}/elicitation with accept or decline,
// ownership-checked and compare-and-set on `status: "pending"`. The turn that asked polls the row, so
// the answer can arrive on any instance. A form with no fields is a yes/no question.
//
// The turn's total generation cap stands still while the card is open (CUR-3983, ScreenAwareDeadline),
// so the person gets time to read it. Running out of time is still a "no": nothing changes unless the
// person said yes.
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";

/** How long the person has to answer. An ordinary turn has about 110s of room under MAX_SAFE for its
 *  waits (deadlineLadder.ts), so 90s fits with the input screen's usual second or two beside it. */
export const CONFIRM_WINDOW_MS = 90_000;
const POLL_MS = 500;

export type ConfirmDecision = "allow" | "deny" | "timeout";

/** The storage the wait needs. The database by default; a fake in tests. */
export interface ConfirmStore {
	open(req: { server: string; tool: string; args: Record<string, unknown>; message: string }): Promise<string>;
	/** "accept" | "decline" | "cancel" once answered, undefined while still pending. */
	read(id: string): Promise<string | undefined>;
	/** Closes a still-pending question as cancelled. False when the person answered first. */
	expire(id: string): Promise<boolean>;
}

export function dbConfirmStore(conversationId: ObjectId): ConfirmStore {
	return {
		async open({ server, tool, args, message }) {
			const now = new Date();
			const inserted = await collections.mcpElicitations.insertOne({
				conversationId,
				status: "pending",
				request: { server, mode: "form", message, fields: [] },
				pending: { server, tool, args, inputKey: "confirm" },
				createdAt: now,
				updatedAt: now,
			});
			return inserted.insertedId.toHexString();
		},
		async read(id) {
			const doc = await collections.mcpElicitations.findOne({ _id: new ObjectId(id), conversationId });
			return doc && doc.status !== "pending" ? (doc.action ?? "cancel") : undefined;
		},
		async expire(id) {
			const res = await collections.mcpElicitations.updateOne(
				{ _id: new ObjectId(id), conversationId, status: "pending" },
				{ $set: { status: "resolved", action: "cancel", resolvedAt: new Date(), updatedAt: new Date() } }
			);
			return res.matchedCount > 0;
		},
	};
}

/**
 * Waits for the person's answer to `id`, until `deadlineAt`. Only an explicit accept is "allow". At the
 * deadline the row is closed as cancelled first, so a click that lands after the turn stopped waiting
 * is refused by the answer route instead of being recorded as a yes that never ran.
 */
export async function awaitConfirmation(
	store: ConfirmStore,
	id: string,
	deadlineAt: number,
	opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}
): Promise<ConfirmDecision> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	for (;;) {
		const action = await store.read(id);
		if (action !== undefined) return action === "accept" ? "allow" : "deny";
		if (opts.signal?.aborted || now() >= deadlineAt) {
			if (await store.expire(id)) return "timeout";
			const late = await store.read(id);
			return late === "accept" ? "allow" : "deny";
		}
		await sleep(Math.min(POLL_MS, Math.max(0, deadlineAt - now())));
	}
}
