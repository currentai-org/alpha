import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { VOICE_RECORDING_MAX_BYTES, voiceRecordingTooLargeMessage } from "$lib/chat/constants/uploadLimits";
import { config } from "$lib/chat/server/config";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { logger } from "$lib/chat/server/logger";
import { dictationEnabled } from "$lib/chat/server/dictationMode";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import {
	TranscriptionStalled,
	fetchWithStallRetry,
	upstreamContentType,
} from "$lib/chat/server/transcribeFetch";


const ALLOWED_CONTENT_TYPES = [
	"audio/webm",
	"audio/ogg",
	"audio/wav",
	"audio/flac",
	"audio/mpeg",
	"audio/mp4",
	"audio/x-wav",
];

export async function POST({ request, locals, getClientAddress }) {
	// Independent of `multimodal` (CUR-198): dictation only ever produces text, which goes through
	// the same moderation any typed message does. See dictationMode.ts.
	if (!dictationEnabled()) {
		throw error(403, "Dictation is disabled.");
	}

	const transcriptionModel = config.get("TRANSCRIPTION_MODEL");

	if (!transcriptionModel) {
		throw error(503, "Transcription is not configured");
	}

	// Its own resolution, not the shared getApiToken() — that helper prefers OPENAI_API_KEY (the
	// CSCS chat key), which is wrong here: this call always hits HF's OWN inference router
	// (baseUrl below), never CSCS. Same shape as models.ts's modelsFallbackApiKey: an HF-hosted
	// lane needs its own token pairing rather than reusing the primary chat credential.
	const token = firstKey(["HF_TOKEN", "OPENAI_API_KEY"], "transcriptionToken");

	// The token's HF Inference-Providers permission is granted org-scoped ("on behalf of" the
	// organisation), not user-scoped — so this call needs X-HF-Bill-To or the router 403s
	// as the personal token owner instead. This is its own route with its own `locals`, so it
	// never inherits the value the main conversation handler sets — same shape as
	// second-opinion/+server.ts.
	locals.billingOrganization = (Reflect.get(config, "HF_BILL_TO") as string | undefined) || undefined;

	if (!token) {
		throw error(401, "Authentication required");
	}

	const rawContentType = request.headers.get("content-type") || "";
	// Normalize content-type: Safari sends "audio/webm; codecs=opus" (with space)
	// but HF API expects "audio/webm;codecs=opus" (no space)
	const contentType = rawContentType.replace(/;\s+/g, ";");
	const isAllowed = ALLOWED_CONTENT_TYPES.some((type) => contentType.includes(type));

	if (!isAllowed) {
		logger.warn({ contentType }, "Unsupported audio format for transcription");
		throw error(400, `Unsupported audio format: ${contentType}`);
	}

	const contentLength = parseInt(request.headers.get("content-length") || "0");
	if (contentLength > VOICE_RECORDING_MAX_BYTES) {
		throw error(413, voiceRecordingTooLargeMessage());
	}

	// A Whisper call per upload, unmetered before this — this route has no requireAuth
	// call (dictation never required sign-in), but `locals.sessionId` is populated for every
	// visitor regardless, so the same limiter applies with no auth change needed. (CUR-832)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});

	try {
		const audioBuffer = await request.arrayBuffer();

		if (audioBuffer.byteLength > VOICE_RECORDING_MAX_BYTES) {
			throw error(413, voiceRecordingTooLargeMessage());
		}

		const baseUrl =
			config.get("TRANSCRIPTION_BASE_URL") || "https://router.huggingface.co/hf-inference/models";
		const apiUrl = `${baseUrl}/${transcriptionModel}`;

		// Each attempt aborts at ATTEMPT_MS and a stall is retried once, so a hung upstream
		// costs 30s instead of a minute. The body is an ArrayBuffer, so it can be sent twice. (CUR-2328)
		const { response, attempts } = await fetchWithStallRetry((signal) =>
			fetch(apiUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": upstreamContentType(contentType),
					...hfBillToHeader(baseUrl, { ownLane: false }, locals?.billingOrganization),
				},
				body: audioBuffer,
				signal,
			})
		);
		logger.info(
			{ model: transcriptionModel, status: response.status, attempts },
			"Transcription answered"
		);

		if (!response.ok) {
			const errorText = await response.text();
			logger.error(
				{ status: response.status, error: errorText, model: transcriptionModel },
				"Whisper API error"
			);
			// The upstream body stays in the log above. It can name the HF user who owns our
			// token (the 403 noted at the top of this handler), and an upstream 429 would reach the
			// client's rate-limit branch, which prints the message. So the browser gets a fixed 502. (CUR-3522)
			throw error(502, `Transcription failed (upstream ${response.status}). Please try again.`);
		}

		const result = await response.json();

		// Whisper API returns { text: "transcribed text" }
		// Filter out responses that only contain dots (e.g. "..." returned for silence/unclear audio)
		const text = (result.text || "").trim();
		const isOnlyDots = /^\.+$/.test(text);
		return json({ text: isOnlyDots ? "" : text });
	} catch (err) {
		if (err instanceof TranscriptionStalled) {
			logger.error({ model: transcriptionModel, attempts: err.attempts }, "Transcription timeout");
			throw error(504, "Transcription took too long. Please try a shorter recording.");
		}

		// Re-throw SvelteKit errors
		if (err && typeof err === "object" && "status" in err) {
			throw err;
		}

		logger.error(err, "Transcription error");
		throw error(500, "Failed to transcribe audio");
	}
}
