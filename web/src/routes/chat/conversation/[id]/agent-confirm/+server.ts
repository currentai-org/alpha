import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { agentServiceUrl, agentServiceToken } from "$lib/chat/server/agentMode";
import { agentServiceHeaders } from "$lib/chat/server/endpoints/agent/endpointAgent";
import {
	FAKE_AGENT_BASE,
	fakeAgentFetch,
	isFakeAgentTaskId,
} from "$lib/chat/server/endpoints/agent/fakeAgentService";
import { loadOwnedConversation } from "$lib/chat/server/loadOwnedConversation";
import { logger } from "$lib/chat/server/logger";

// Delivers a human's allow/deny answer to a tool call agent-service paused mid-run under
// ACP_PERMISSION_POLICY=confirm. This is the ONE write this repo makes against
// agent-service's task state from outside the turn that created it — everywhere else (the /run
// submission, the artifact-download proxy) only ever reads or starts. Same threat model as the
// sibling agent-artifact route: same conversation-ownership check, same headers reused from the turn
// that opened the task.
//
// Deliberately thin: the authoritative outcome is the `confirm_result` SSE frame the ALREADY-OPEN
// `/run/{taskId}/events` stream delivers once agent-service resolves the pause (endpointAgent.ts's
// existing reader loop is what's listening — this route never touches that connection). This route
// only has to get the click there; it does not race to declare a result itself.
export const POST: RequestHandler = async ({ locals, params, request }) => {
	await loadOwnedConversation(locals, params.id);

	const body = z
		.object({
			taskId: z.string().min(1),
			confirmId: z.string().min(1),
			decision: z.enum(["allow", "deny"]),
		})
		.safeParse(await request.json().catch(() => null));
	if (!body.success) {
		error(400, "Invalid request body.");
	}
	const { taskId, confirmId, decision } = body.data;

	// A task the scenario suite's stand-in minted is answered by the stand-in, as its re-attach and Stop
	// are. In production the stand-in answers 404, which reads as "No such agent task."
	const fake = isFakeAgentTaskId(taskId);
	const baseURL = fake ? FAKE_AGENT_BASE : agentServiceUrl();
	if (!baseURL) {
		// AGENT_SERVICE_URL unset is the same class of loud misconfiguration agentModeEnabled() and the
		// agent-artifact route guard — log it, don't leak internal config state to the response.
		logger.warn("[agent-confirm] AGENT_SERVICE_URL is unset; no agent-service to deliver the answer to");
		error(404, { message: "The agent service isn't reachable right now.", reason: "service_unreachable" });
	}

	const token = agentServiceToken();
	// SAME derivation endpointAgent.ts used to submit the task this confirmation belongs to — agent-
	// service's `_may_access` compares against exactly this principal (caller + subject), so a
	// different derivation here would get a 403 even for the task's own owner.
	const headers = { "content-type": "application/json", ...agentServiceHeaders(token, locals) };

	// A configured-but-unreachable agent-service (DNS, ECONNREFUSED, TLS) throws here rather than
	// returning a Response. The route's `service_unreachable` reason covers it, as it does
	// a missing baseURL, so the client (AgentConfirmPrompt.svelte) gets that copy instead of a raw 500
	// and a generic "Couldn't send that — try again." A retry can't help when the service is down.
	let upstream: Response;
	try {
		upstream = await (fake ? fakeAgentFetch : fetch)(`${baseURL.replace(/\/$/, "")}/run/${encodeURIComponent(taskId)}/confirm`, {
			method: "POST",
			headers,
			body: JSON.stringify({ confirm_id: confirmId, decision }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		logger.warn({ err }, "[agent-confirm] /confirm submission failed before a response arrived");
		error(502, { message: "The agent service is unreachable right now.", reason: "service_unreachable" });
	}

	if (upstream.status === 404) error(404, { message: "No such agent task.", reason: "not_found" });
	if (upstream.status === 403) {
		error(403, { message: "This confirmation doesn't belong to you.", reason: "not_yours" });
	}
	if (upstream.status === 409) {
		// Already resolved — another click, or agent-service's own timeout beat this one there. Not an
		// error the caller did anything wrong to cause; the confirm_result SSE frame already carries (or
		// is about to carry) the real outcome, so this is a stale-click no-op, not a failure to surface.
		return json({ ok: false, reason: "already_resolved" }, { status: 409 });
	}
	if (!upstream.ok) {
		error(502, { message: "The agent service rejected the confirmation.", reason: "upstream_error" });
	}

	return json({ ok: true });
};
