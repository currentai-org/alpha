// Serves one read-aloud clip. The segment is the sealed text and language a turn put in
// message.mcp.audio (readAloudSpeech.ts); this opens it and synthesizes the MP3. Only this server can
// seal a clip, so the route reads nothing a visitor chose and stores nothing. Each fetch is a billed
// synthesis, so the clip plays only for the owner of the conversation it was sealed in; anyone else,
// including a viewer of a shared copy, gets the same 404 as a forged segment. (CUR-3151)
import { error, redirect } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { authCondition } from "$lib/chat/server/auth";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger";
import { CANNED_READ_ALOUD_CLIP } from "$lib/chat/server/mcp";
import { kokoroVoice } from "$lib/chat/server/mcp/readAloudLanguage";
import { openSpeechClip, synthesizeSpeech } from "$lib/chat/server/mcp/readAloudSpeech";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import type { RequestHandler } from "./$types";

// Chatterbox typically answers in 1–3 s, with outliers at 11–14 s.
const SYNTH_TIMEOUT_MS = 25_000;

export const GET: RequestHandler = async ({ params, locals, getClientAddress, request }) => {
	const clip = openSpeechClip(params.clip);
	if (!clip || !ObjectId.isValid(clip.conversation)) throw error(404, "No such clip");
	const owned = await collections.conversations.countDocuments({
		_id: new ObjectId(clip.conversation),
		...authCondition(locals),
	});
	if (!owned) throw error(404, "No such clip");
	// The same limiter as every other billed side route (CUR-832). The browser's private cache
	// spares an ordinary replay, but a script fetching its own clip URL in a loop pays per synthesis. (CUR-3519)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	// Under `tts_canned_clip` (preview plus the e2e secret) the clip is the canned one, so a
	// spec that plays a sealed clip gates on our player and not on the synthesis provider's uptime. (CUR-4085)
	if ((await resolveFaultInjection(request)) === "tts_canned_clip") {
		logger.info({ reason: "tts_canned_clip" }, "[read-aloud] canned clip, synthesis skipped");
		throw redirect(302, CANNED_READ_ALOUD_CLIP);
	}

	// The voice is logged beside the language, so Axiom can show which voice read a clip. (CUR-3989)
	const voice = kokoroVoice(clip.language);
	const t0 = Date.now();
	let response: Response;
	try {
		response = await synthesizeSpeech(clip, AbortSignal.timeout(SYNTH_TIMEOUT_MS));
	} catch (e) {
		// Lengths and language only: the text is the answer, so it stays out of the logs.
		logger.warn(
			{ err: e, ms: Date.now() - t0, chars: clip.text.length, language: clip.language, voice },
			"[read-aloud] synthesis failed"
		);
		throw error(504, "Read aloud took too long");
	}
	if (!response.ok) {
		logger.warn(
			{ status: response.status, ms: Date.now() - t0, chars: clip.text.length, language: clip.language, voice },
			"[read-aloud] synthesis refused"
		);
		throw error(502, "Read aloud is unavailable right now");
	}
	const audio = await response.arrayBuffer();
	logger.info(
		{ ms: Date.now() - t0, bytes: audio.byteLength, chars: clip.text.length, language: clip.language, voice },
		"[read-aloud] clip synthesized"
	);
	return new Response(audio, {
		headers: {
			"Content-Type": "audio/mpeg",
			// The same URL always reads the same text, so a browser may keep the clip; never a shared cache.
			"Cache-Control": "private, max-age=86400",
		},
	});
};
