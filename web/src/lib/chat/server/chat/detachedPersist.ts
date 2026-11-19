import { MessageUpdateStatus, MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

/**
 * Minimum gap between whole-conversation writes while the client is gone. An attached turn writes
 * nothing mid-turn (only the final answer and the terminal persist), so a detached one must not
 * write per token either; this keeps a partial answer recoverable if the function is killed.
 */
const DETACHED_PERSIST_INTERVAL_MS = 2_000;

/**
 * Decides, per outgoing update of a turn whose client has detached, whether to write the conversation.
 *
 * @remarks
 * Keepalives never write (they are filtered out of the saved document anyway). The final answer always
 * writes. Everything else writes at most once per interval. The terminal persist after the loop saves
 * whatever the gate skipped.
 */
export function createDetachedPersistGate(
	intervalMs: number = DETACHED_PERSIST_INTERVAL_MS,
	now: () => number = Date.now
) {
	let lastWriteAt = Number.NEGATIVE_INFINITY;
	return (update: MessageUpdate): boolean => {
		if (update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.KeepAlive) {
			return false;
		}
		const t = now();
		if (update.type !== MessageUpdateType.FinalAnswer && t - lastWriteAt < intervalMs) return false;
		lastWriteAt = t;
		return true;
	};
}
