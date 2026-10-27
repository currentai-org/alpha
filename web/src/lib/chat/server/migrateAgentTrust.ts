import { agentServiceUrl, agentServiceToken } from "$lib/chat/server/agentMode";
import { deriveAgentSubject } from "$lib/chat/server/endpoints/agent/endpointAgent";
import { logger } from "$lib/chat/server/logger";
import type { User } from "$lib/chat/types/User";

// Re-key an anonymous session's accrued agent trust onto the account signing in (CUR-761) — same
// reasoning and same call sites as migrateAnonymousConversations/migrateAnonymousSettings:
// authentication should only ever RAISE a caller's trust ceiling, never zero it.
// agent-service's caller_history is keyed on X-Agent-Subject (deriveAgentSubject), which switches
// from the anonymous session's sessionId to the signed-in user's _id (agentSubjectFor) — without
// this, that switch silently resets the caller to a fresh "new" tier under the staged trust policy,
// discarding whatever trust the anonymous session had earned.

/**
 * Best-effort and non-blocking: sign-in must succeed even when agent-service is unreachable or
 * unconfigured — this only prevents a WORSE outcome (a silent reset) than doing nothing at all, so
 * its own failure can never be worse than the bug it exists to fix.
 */
export async function migrateAgentTrust(
	previousSessionId: string | undefined,
	userId: User["_id"]
): Promise<void> {
	if (!previousSessionId) {
		return;
	}
	const baseURL = agentServiceUrl();
	const token = agentServiceToken();
	if (!baseURL || !token) {
		// No agent service configured (or its own auth disabled) — nothing to migrate, and nothing to
		// warn about: every deploy without agent mode on hits this path on every sign-in.
		return;
	}
	const oldSubject = deriveAgentSubject(token, previousSessionId);
	const newSubject = deriveAgentSubject(token, userId.toString());
	if (!oldSubject || !newSubject || oldSubject === newSubject) {
		return;
	}
	try {
		const res = await fetch(`${baseURL.replace(/\/$/, "")}/callers/migrate`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ old_subject: oldSubject, new_subject: newSubject }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			logger.warn(
				{ status: res.status },
				"[migrateAgentTrust] agent-service rejected the trust migration"
			);
		}
	} catch (err) {
		logger.warn({ err }, "[migrateAgentTrust] failed to reach agent-service");
	}
}
