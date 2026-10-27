import { agentServiceUrl, agentServiceToken } from "$lib/chat/server/agentMode";
import { deriveAgentSubject } from "$lib/chat/server/endpoints/agent/endpointAgent";
import { logger } from "$lib/chat/server/logger";

// agent-service keeps a fully separate SQLite store (agent-service/api/store.py) for
// agent-mode task history and session workdirs, keyed by the same HMAC-derived subject
// migrateAgentTrust.ts already computes for trust migration — wipeUserData.ts calls into it, since
// otherwise a deleted account's agent-mode history would survive the wipe. Same reference pattern as
// migrateAgentTrust.ts: best-effort and non-blocking (the trash-all's own DB wipe is the part that
// must always succeed; this is additive to it), same bearer auth, same subject derivation. (CUR-1722)

/**
 * Delete this visitor's agent-service task history and session workdirs. `visitor` is whichever of
 * sessionId/userId wipeUserData.ts has for this wipe — the same value agentSubjectFor derives an
 * X-Agent-Subject from when the turn that created the history ran.
 *
 * Returns the number of task rows deleted, or undefined when there is nothing to report: agent mode
 * is off for this deployment (no URL/token set — every deploy without it hits this on every wipe),
 * or the request itself did not come back ok. Best-effort throughout — never blocks or fails the
 * wipe itself.
 */
export async function deleteAgentServiceData(visitor: string | undefined): Promise<number | undefined> {
	return postDelete("deleteAgentServiceData", "/callers/delete", visitor, {}, "tasks_deleted");
}

/**
 * Delete what agent-service holds for these conversations: each one's session workdir and its
 * sandboxes, the run-code one and the agent one (CUR-4484). `visitor` is the same value
 * `deleteAgentServiceData` takes, so the subject matches the one the conversation's turns ran under.
 *
 * Returns how many sandboxes went, or undefined when agent mode is off here or the call failed.
 * Best-effort, as above: the conversation is deleted in chat either way, and agent-service's idle
 * sweep removes a sandbox this missed.
 */
export async function deleteAgentSessions(
	visitor: string | undefined,
	conversationIds: string[]
): Promise<number | undefined> {
	if (conversationIds.length === 0) return undefined;
	return postDelete(
		"deleteAgentSessions",
		"/sessions/delete",
		visitor,
		{ session_ids: conversationIds },
		"sandboxes_deleted"
	);
}

/** One best-effort delete call to agent-service under the visitor's subject; the count field, or undefined. */
async function postDelete(
	tag: string,
	path: string,
	visitor: string | undefined,
	extra: Record<string, unknown>,
	countField: string
): Promise<number | undefined> {
	if (!visitor) return undefined;
	const baseURL = agentServiceUrl();
	const token = agentServiceToken();
	if (!baseURL || !token) return undefined;
	const subject = deriveAgentSubject(token, visitor);
	if (!subject) return undefined;
	try {
		const res = await fetch(`${baseURL.replace(/\/$/, "")}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ subject, ...extra }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			logger.warn({ status: res.status }, `[${tag}] agent-service rejected the delete`);
			return undefined;
		}
		const body = (await res.json()) as Record<string, number | undefined>;
		return body[countField];
	} catch (err) {
		logger.warn({ err }, `[${tag}] agent-service call did not complete`);
		return undefined;
	}
}
