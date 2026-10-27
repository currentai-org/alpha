// Multimodal upload path: turn an uploaded IMAGE into embeddable TEXT via a vision-language model
// (OCR + description), then feed that text to the SAME create→chunk→embed pipeline as every other
// upload. This keeps the store a single unified text-embedding space (no CLIP / second vector space):
// a fit for a small store that already has an OpenAI-compatible multimodal
// endpoint and a proven image_url call shape (src/lib/chat/server/textGeneration/utils/prepareFiles.ts).
//
// Posture: one-shot, non-streaming, temperature 0, JSON out (ocr_text + description + tags), with the
// text instruction BEFORE the image part. Best-effort — a failed/garbled call surfaces as a per-file
// upload error, and the resulting draft is human-reviewed before activation (the approval gate), which
// mitigates silent OCR/caption mistakes. Oversized images are downscaled with sharp first to bound
// the vision token cost and request payload.

import sharp from "sharp";
import { config } from "$lib/chat/server/config";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { ragVisionModel, embeddingBillTo, embeddingToken } from "./env";
import { titleFromFilename } from "$lib/chat/constants/ragUpload";
import { logger } from "$lib/chat/server/logger";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";

/** A captioning problem the route maps to a 4xx/5xx (no model, model error, empty result). */
export class RagCaptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RagCaptionError";
	}
}

export type CaptionResult = { title: string; text: string };

const VISION_PROMPT =
	"You are an indexing assistant for a search engine. Describe this image so it can be found by " +
	"text search. Return ONLY JSON with three fields: ocr_text (verbatim transcription of ALL visible " +
	"text exactly as written, including numbers, labels, and any chart or table values; empty string " +
	"if there is no text), description (3-5 sentences naming the objects, people, layout, and the data " +
	"shown in any chart or table), tags (a lowercase array of 5-15 search keywords). Describe only what " +
	"is visibly present. Do not speculate, do not add marketing language, do not hedge.";

type VisionFields = { ocr_text: string; description: string; tags: string[] };

/** Defensively parse the model's reply into the three fields. Tolerates ```json fences and prose
 *  around the object; if no JSON object is found, treats the whole reply as the description. */
export function parseVisionJson(content: string): VisionFields {
	const empty: VisionFields = { ocr_text: "", description: "", tags: [] };
	const raw = (content || "").trim();
	if (!raw) return empty;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
			const tags = Array.isArray(obj.tags)
				? obj.tags.map((t) => String(t).trim()).filter(Boolean)
				: [];
			return {
				ocr_text: typeof obj.ocr_text === "string" ? obj.ocr_text : "",
				description: typeof obj.description === "string" ? obj.description : "",
				tags,
			};
		} catch {
			/* fall through to the prose fallback */
		}
	}
	// Non-JSON reply: keep the prose so the upload isn't lost (admin reviews it before activation).
	return { ...empty, description: raw };
}

/** Build the embeddable text from the parsed fields: OCR first (exact strings), then description,
 *  then keywords — the order a retrieval query is most likely to match. */
export function assembleImageText(fields: VisionFields): string {
	const parts: string[] = [];
	if (fields.ocr_text.trim()) parts.push(fields.ocr_text.trim());
	if (fields.description.trim()) parts.push(fields.description.trim());
	if (fields.tags.length) parts.push(`Tags: ${fields.tags.join(", ")}`);
	return parts.join("\n\n");
}

/** The vision model id: explicit RAG_VISION_MODEL / router multimodal model, else the first
 *  multimodal model in the registry, else the default served model. The models registry is imported
 *  lazily — it builds itself at import time and throws without OPENAI_BASE_URL, which must not happen
 *  when the pure helpers (parseVisionJson/assembleImageText) are imported in the hermetic test gate.
 *
 *  The last step sends an image to a model nobody declared able to read one, so it logs both facts at
 *  warn (`visionModelFallback`) rather than passing silently (CUR-2319). `registry` is for specs. */
export async function pickVisionModel(registry?: {
	models: { id: string; multimodal?: boolean }[];
	defaultModel?: { id?: string; name?: string };
}): Promise<string> {
	const configured = ragVisionModel();
	if (configured) return configured;
	const { models, defaultModel } = registry ?? (await import("$lib/chat/server/models"));
	const mm = models.find((m) => m.multimodal);
	if (mm) return mm.id;
	const fallback = defaultModel?.id ?? defaultModel?.name ?? "";
	if (fallback) {
		logger.warn(
			{ visionModelFallback: true, servedModel: fallback },
			"[rag] no vision model is configured and none registered is multimodal; captioning with the default model"
		);
	}
	return fallback;
}

/** Downscale/re-encode an oversized image to bound vision token cost + payload. Best-effort: on any
 *  sharp failure the original bytes are used (the upstream byte cap already bounds the worst case). */
async function normalizeImage(
	bytes: Uint8Array,
	declaredMime?: string
): Promise<{ data: Buffer; mime: string }> {
	try {
		const img = sharp(Buffer.from(bytes));
		const meta = await img.metadata();
		const tooBig = (meta.width ?? 0) > 1280 || (meta.height ?? 0) > 1280;
		const pipeline = tooBig ? img.resize(1280, 1280, { fit: "inside" }) : img;
		const data = await pipeline.jpeg({ quality: 80 }).toBuffer();
		return { data, mime: "image/jpeg" };
	} catch {
		return { data: Buffer.from(bytes), mime: declaredMime || "image/png" };
	}
}

/** Caption + OCR an image into embeddable text via the multimodal endpoint. Throws RagCaptionError. */
export async function captionImage(input: {
	bytes: Uint8Array;
	name: string;
	declaredMime?: string;
}): Promise<CaptionResult> {
	const model = await pickVisionModel();
	if (!model) {
		throw new RagCaptionError("No vision model is configured for image captioning.");
	}
	const { data, mime } = await normalizeImage(input.bytes, input.declaredMime);
	const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
	const billTo = embeddingBillTo();

	let content: string;
	try {
		const client = await createOpenAIClient({
			baseURL: config.OPENAI_BASE_URL,
			// Same dedicated RAG token as the embeddings path (HF_RAG_EMBEDDINGS_TOKEN, falling back to
			// the shared inference key) — image captioning is RAG ingestion, so it bills like the rest.
			apiKey: embeddingToken() || "sk-",
			// Ingestion rather than a turn, so a slow caption costs nobody an answer and this is a
			// leak-stopper rather than a latency budget — without it a hung vision request holds the
			// invocation open until the platform kills it (CUR-1345).
			timeout: 60_000,
			defaultHeaders: {
				"User-Agent": "aipotluck.org",
				// Bill vision inference to the configured HF org when OPENAI_BASE_URL is the HF router.
				...hfBillToHeader(config.OPENAI_BASE_URL, { ownLane: false }, billTo),
			},
		});
		const res = await client.chat.completions.create({
			model,
			messages: [
				{
					role: "user",
					// Text instruction BEFORE the image part (sequential processing improves extraction).
					content: [
						{ type: "text", text: VISION_PROMPT },
						{ type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
					],
				},
			],
			temperature: 0,
			max_tokens: 800,
			stream: false,
		});
		content = res.choices?.[0]?.message?.content ?? "";
	} catch (e) {
		logger.warn(e, "[rag] image caption call failed");
		throw new RagCaptionError("The vision model could not describe this image; try again.");
	}

	const text = assembleImageText(parseVisionJson(content));
	if (!text.trim()) {
		throw new RagCaptionError("The vision model returned no usable description for this image.");
	}
	return { title: titleFromFilename(input.name), text };
}
