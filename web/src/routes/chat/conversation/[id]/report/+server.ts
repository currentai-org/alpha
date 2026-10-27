/**
 * Report a problem with a response — the user-facing flag affordance the Terms page promises
 * ("use the control beneath any response to flag it"). Mirrors the Vercel app's report route and
 * writes through saveReport (db/reports.ts), the single ROOST triage seam. Present on every
 * session regardless of auth: a guest can flag, so there is no auth WALL, but the report
 * is scoped to a conversation the caller actually owns (authCondition) so reports can't be forged
 * against arbitrary conversation ids.
 */
import { ANSWER_REPORT_REASON_KEYS } from "$lib/chat/reportReasons";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { saveReport } from "$lib/chat/server/db/reports";
import { fanOutReport } from "$lib/chat/server/reportFanout";
import { reportToCoop } from "$lib/chat/server/moderation";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { ObjectId } from "bson";
import { z } from "zod";

const reportSchema = z.object({
	// Which message in the conversation is being flagged (optional — a report can be
	// conversation-level). Kept as a free string; the UI passes the assistant message id.
	messageId: z.string().max(128).nullish(),
	reason: z.enum(ANSWER_REPORT_REASON_KEYS),
	detail: z.string().max(2000).nullish(),
});

export const POST: RequestHandler = async ({ request, locals, params, getClientAddress }) => {
	let body: z.infer<typeof reportSchema>;
	try {
		body = reportSchema.parse(await request.json());
	} catch {
		throw error(400, "A valid reason is required.");
	}

	const id = z.string().parse(params.id);
	const convId = new ObjectId(id);

	// Scope to a conversation the caller owns (guest session or logged-in user). Prevents
	// forging reports against conversations the caller is not part of.
	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});
	if (!conv) {
		throw error(404, "Conversation not found");
	}

	// The same limiter as the other side routes (CUR-832). Fan-out dedupes per session only,
	// so without this a guest who clears the cookie between reports opens a new tracker issue and chat
	// post each time. A 429 here saves nothing and sends nothing. (CUR-3520)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	// Snapshot the answer into the row (CUR-997). Deleting the conversation keeps the report but
	// detaches it, so this copy is the only record left of what was reported. The model is the one
	// that actually served when the answer carries provenance, else the one the conversation asked for.
	const reported = conv.messages.find((m) => m.id === body.messageId);
	let saved: Awaited<ReturnType<typeof saveReport>>;

	try {
		saved = await saveReport({
			conversationId: id,
			messageId: body.messageId ?? undefined,
			userId: locals.user?._id?.toString(),
			sessionId: locals.sessionId,
			reason: body.reason,
			detail: body.detail ?? undefined,
			answerText: reported?.content,
			answerModel: reported ? (reported.routerMetadata?.model ?? conv.model) : undefined,
		});
	} catch {
		throw error(500, "Failed to save report");
	}

	// Forward to Coop so the flag surfaces in the triage dashboard. The conversation (with its
	// messages) is already loaded above, so the reported message's text is an in-memory lookup — no
	// extra query. Best-effort: the report is already persisted, so a Coop failure or missing config
	// must not fail the user's flag; reportToCoop skips internally unless fully configured and never
	// rejects. Through runInBackground (coop-review-plane Step 1b): reportToCoop returns its fetch
	// chain, and a bare detached fetch would FREEZE on Vercel Node the instant this response returns —
	// the report would never actually land. runInBackground schedules it via waitUntil (no added
	// latency) or awaits it inline when there is no context; the response still goes out immediately.
	await runInBackground(
		reportToCoop({
			messageId: body.messageId ?? undefined,
			text: reported?.content,
			reason: body.reason,
			reporterId: locals.user?._id?.toString() ?? locals.sessionId,
			// Preview plus the e2e secret only, so a spec can see a Coop refusal leave the flag intact. (CUR-2598)
			injectedStatus: (await resolveFaultInjection(request)) === "coop_report_rate_limited" ? 429 : undefined,
		})
	);

	// Chat and tracker fan-out, behind the `report-fanout` flag (CUR-997). Same best-effort shape as Coop: the
	// row is saved, fanOutReport never rejects, and it sends a link, never the answer.
	await runInBackground(fanOutReport(saved));

	return json({ ok: true });
};
