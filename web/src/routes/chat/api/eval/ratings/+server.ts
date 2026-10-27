// Record one rating (CUR-1914). Signed-in only. A rating with a required question missing is
// refused and the missing questions are named, so the flow can point at them.
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { humanEvalEnabled } from "$lib/chat/server/humanEval/gate";
import { submitRating } from "$lib/chat/server/humanEval/service";

const bodySchema = z.object({
	modelRunId: z.string().min(1).max(64),
	scores: z.record(z.string(), z.union([z.number(), z.string()])),
	flags: z.array(z.string().max(40)).max(10).default([]),
	comment: z.string().max(2000).nullish(),
	durationMs: z.number().nonnegative(),
});

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!humanEvalEnabled()) throw error(404, "Not found");
	if (!locals.user) throw error(401, "Sign in to evaluate.");
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, "Malformed rating.");

	const result = await submitRating(locals.user._id.toString(), parsed.data);
	if (!result.ok) {
		return json(
			{ ok: false, reason: result.reason, missing: result.missing ?? [], invalid: result.invalid ?? [] },
			{ status: result.status }
		);
	}
	return json({ ok: true });
};
