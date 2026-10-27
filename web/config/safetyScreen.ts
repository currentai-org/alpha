// The Zentropi CoPE judge for the chat turn's input screen (CUR-4340). When the typed text of a turn is
// one of the routed languages, the input screen asks this model each rule's question instead of
// Shieldstral; any failed call goes to Shieldstral, with no retry (detectors/zentropi.ts). The model is
// Zentropi's open-weight zentropi-ai/cope-b-a4b on our own Hugging Face Inference Endpoint (vLLM,
// OpenAI chat completions), not Zentropi's hosted API, whose rate limit (a burst of about 10 calls, then
// 0.2-0.4 calls/s) is below the 16 calls one turn can make (CUR-4361). The PostHog flag
// `zentropi-african-routing` decides on/off; everything below is the declared config the feature runs
// on, so a change is a reviewed diff (docs/guides/config-placement.md). Env holds the key only.

import { z } from "zod";

// Same shape as a provider in inference.ts: the key's env var NAME, never the key. Local rather than
// inference.ts's providerSchema, which also requires `lists_models`; this judge discovers no models.
const zentropiJudgeSchema = z.object({
	provider: z.object({
		name: z.string().min(1),
		api_base: z.string().url(),
		api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "api_key_env names an env var, not a key"),
	}),
	model: z.string().min(1),
	/** Per call. Past it the call goes to Shieldstral. */
	timeoutMs: z.number().int().positive(),
	/** Trigram profile code -> the language tag logged and tested. Only these route. */
	routedLanguages: z.record(z.string(), z.string().min(1)).refine((m) => Object.keys(m).length > 0, "no routed language"),
});

/** Parses at module load, so a bad edit fails `pnpm check` and the unit tests, not a turn. */
export function parseZentropiJudgeConfig(raw: unknown): z.infer<typeof zentropiJudgeSchema> {
	return zentropiJudgeSchema.parse(raw);
}

const ZENTROPI_JUDGE_RAW = {
	provider: {
		name: "zentropi-cope-hf",
		api_base: "https://6ad97f72eefe43aa1376fbea.endpoints.huggingface.cloud",
		api_key_env: "HF_TOKEN",
	},
	model: "zentropi-ai/cope-b-a4b",
	// 5 s, then Shieldstral. At 8 calls in flight the endpoint answers in p50 0.10 s / p95 0.12 s
	// (policy-optimizer harness, 4,121 calls), agreeing with Zentropi's hosted API on 99.76%.
	timeoutMs: 5000,
	routedLanguages: { amh: "am", yor: "yo", hau: "ha", swh: "sw" },
} as const;

parseZentropiJudgeConfig(ZENTROPI_JUDGE_RAW);

export const ZENTROPI_JUDGE = ZENTROPI_JUDGE_RAW;

export type RoutedLanguage = (typeof ZENTROPI_JUDGE.routedLanguages)[keyof typeof ZENTROPI_JUDGE.routedLanguages];

// The Zentropi S1 judge for the chat turn's input and output screens (CUR-4527). With the PostHog flag
// `s1-safety-judge` on, every text chunk of a turn is judged by zentropi-ai/cope-b-s1 against the
// policies in web/src/lib/chat/server/rules-s1.json (detectors/s1.ts), and the CoPE routing above is not
// used for that turn. The endpoint is our own Hugging Face Inference Endpoint
// `cope-b-s1-eval-20261022` (A100, min replicas 1, image zentropiai/cope-s1-sglang, MAX_LEN and
// CONTEXT_LEN 32768), which serves Zentropi's `POST /v1/systemone`. Env holds the key only.
const s1JudgeSchema = z.object({
	provider: zentropiJudgeSchema.shape.provider,
	/** The id stored as the screen's served model. */
	model: z.string().min(1),
	/** The model name the endpoint takes in the request and reports back in `model`. */
	requestModel: z.string().min(1),
});

function parseS1JudgeConfig(raw: unknown): z.infer<typeof s1JudgeSchema> {
	return s1JudgeSchema.parse(raw);
}

const S1_JUDGE_RAW = {
	provider: {
		name: "zentropi-s1-hf",
		api_base: "https://6ada5fa5a0e732657786181a.endpoints.huggingface.cloud",
		api_key_env: "HF_TOKEN",
	},
	model: "zentropi-ai/cope-b-s1",
	requestModel: "cope-b-s1",
} as const;

parseS1JudgeConfig(S1_JUDGE_RAW);

export const S1_JUDGE = S1_JUDGE_RAW;
