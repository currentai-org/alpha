// Declare a language and a level, and agree to how ratings are used, before the first rating
// (CUR-1914). Signed-in only.
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { upsertProfile } from "$lib/chat/server/db/humanEval";
import { isLanguageOpen, varietiesFor } from "$lib/chat/server/humanEval/config";
import { humanEvalEnabled, includeDraftLanguages } from "$lib/chat/server/humanEval/gate";
import { CONSENT_VERSION, completeCalibration } from "$lib/chat/server/humanEval/service";

const bodySchema = z.object({
	language: z.string().min(2).max(8),
	level: z.enum(["native", "fluent", "working"]),
	variety: z.string().max(16).nullish(),
	consent: z.literal(true),
	/** Sent once the person has gone through the calibration example. */
	calibrationDone: z.boolean().optional(),
});

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!humanEvalEnabled()) throw error(404, "Not found");
	if (!locals.user) throw error(401, "Sign in to evaluate.");
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, "A language, a level and consent are required.");
	const { language, level, variety, calibrationDone } = parsed.data;
	if (!isLanguageOpen(language, includeDraftLanguages())) throw error(404, "This language is not open for evaluation yet.");
	if (variety && !varietiesFor(language).some((v) => v.value === variety)) {
		throw error(400, "Unknown variety for this language.");
	}

	const userId = locals.user._id.toString();
	await upsertProfile({ userId, language, level, variety, consentVersion: CONSENT_VERSION });
	if (calibrationDone) await completeCalibration(userId, language);
	return json({ ok: true });
};
