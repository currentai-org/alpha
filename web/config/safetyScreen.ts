// The safety judges' declared config. A PostHog flag decides each one on/off; everything below is the
// config the feature runs on, so a change is a reviewed diff (docs/guides/config-placement.md). Env
// holds the key, and the endpoint's address off Current AI's own deployments (judgeApiBase, in
// src/lib/chat/server/detectors/judgeApiBase.ts: it reads the deployment's env, and this file is
// reached from client code, so it holds data only).

import { z } from "zod";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// Same shape as a provider in inference.ts: the key's env var NAME, never the key. Local rather than
// inference.ts's providerSchema, which also requires `lists_models`; this judge discovers no models.
// `deployed_api_base` is Current AI's own endpoint, used only where DEPLOY_ENV (or VERCEL_ENV) says
// production or preview; `api_base_env` names the env var that sets the address anywhere, and is the
// only source of one elsewhere (detectors/judgeApiBase.ts).
const judgeProviderSchema = z.object({
	name: z.string().min(1),
	deployed_api_base: z.string().url(),
	api_base_env: z.string().regex(ENV_NAME, "api_base_env names an env var, not an address"),
	api_key_env: z.string().regex(ENV_NAME, "api_key_env names an env var, not a key"),
});

export type JudgeProvider = z.infer<typeof judgeProviderSchema>;

// The Zentropi S1 judge for the chat turn's input and output screens. With the PostHog flag
// `s1-safety-judge` on, every text chunk of a turn is judged by zentropi-ai/cope-b-s1 against the
// policies in web/src/lib/chat/server/rules-s1.json (detectors/s1.ts). The endpoint is our own Hugging
// Face Inference Endpoint `cope-b-s1-eval-20261022` (A100, min replicas 1, image zentropiai/cope-s1-sglang, MAX_LEN and
// CONTEXT_LEN 32768), which serves Zentropi's `POST /v1/systemone`. Env holds the key, and the address
// off Current AI's own deployments.
const s1JudgeSchema = z.object({
	provider: judgeProviderSchema,
	/** The id stored as the screen's served model. */
	model: z.string().min(1),
	/** The model name the endpoint takes in the request and reports back in `model`. */
	requestModel: z.string().min(1),
});

/** Parses at module load, so a bad edit fails `pnpm check` and the unit tests, not a turn. */
export function parseS1JudgeConfig(raw: unknown): z.infer<typeof s1JudgeSchema> {
	return s1JudgeSchema.parse(raw);
}

const S1_JUDGE_RAW = {
	provider: {
		name: "zentropi-s1-hf",
		deployed_api_base: "https://6ada5fa5a0e732657786181a.endpoints.huggingface.cloud",
		api_base_env: "ZENTROPI_S1_ENDPOINT_URL",
		api_key_env: "HF_TOKEN",
	},
	model: "zentropi-ai/cope-b-s1",
	requestModel: "cope-b-s1",
} as const;

parseS1JudgeConfig(S1_JUDGE_RAW);

export const S1_JUDGE = S1_JUDGE_RAW;

// The Mila suicide-prevention classifier for the chat turn's finished answer (flag `mila-sp-output-guard`).
// It scores the assistant response alone, in English or French; p(unsafe) is the sigmoid of the one raw
// logit `POST /predict` returns with `raw_scores: true`, and the model card's label is 1 at p >= 0.5. The
// endpoint is our own Hugging Face Inference Endpoint `mila-sp-output-guardrail-eu` (TEI, 512 tokens per
// input with the two special tokens, 32 inputs per call). detectors/milaSp.ts reads it. Env holds the key,
// and the address off Current AI's own deployments.
const milaSpGuardSchema = z.object({
	provider: judgeProviderSchema,
	/** p(unsafe) at or above it flags the answer. */
	threshold: z.number().min(0).max(1),
	/** One budget for the whole check (tokenize and every predict call). Past it the check is unknown. */
	timeoutMs: z.number().int().positive(),
});

function parseMilaSpGuardConfig(raw: unknown): z.infer<typeof milaSpGuardSchema> {
	return milaSpGuardSchema.parse(raw);
}

const MILA_SP_GUARD_RAW = {
	provider: {
		name: "mila-sp-hf",
		deployed_api_base: "https://6ae4cc0afef6e9d4f6123fcd.endpoints.huggingface.cloud",
		api_base_env: "MILA_SP_ENDPOINT_URL",
		api_key_env: "HF_TOKEN",
	},
	threshold: 0.5,
	timeoutMs: 2000,
} as const;

parseMilaSpGuardConfig(MILA_SP_GUARD_RAW);

export const MILA_SP_GUARD = MILA_SP_GUARD_RAW;

// Which detector screens chat text (SAFETY_SCREEN, detectors/safetyScreen.ts). A reviewed product
// decision per edition, so it lives here and the env var is only the operator's override.
//   shieldstral      Shieldstral-1.0-3B answers one yes/no question per rule (17 calls per input turn).
//   qwen3guard       Qwen3Guard-Gen-0.6B screens the turn in one call and answers 13 rules from its
//                    categories; Shieldstral answers the four rules whose handling is special (the two
//                    child rules, which fail closed, self-harm method, which gets the crisis message,
//                    and anthro). The self-host default: it fits a CPU where the 17 calls do not.
//   qwen3guard-only  Qwen3Guard alone, for very weak hardware. It cannot give the crisis message, fail
//                    the child rules closed from a child-specific verdict, or see anthropomorphism
//                    (selfhost/README.md, "A safety screen"). Never a default.
export const SAFETY_SCREENS = ["shieldstral", "qwen3guard", "qwen3guard-only"] as const;
export type SafetyScreen = (typeof SAFETY_SCREENS)[number];

export const SAFETY_SCREEN_DEFAULT: Record<"hosted" | "selfhost", SafetyScreen> = {
	hosted: "shieldstral",
	selfhost: "qwen3guard",
};

/** The rules the paired screen keeps on Shieldstral: Qwen3Guard has no category for them (anthro), no
 *  child-specific one (both child rules), or no method-versus-distress split for self-harm. */
export const SHIELDSTRAL_PAIRED_RULES = [
	"chat-block-child-sexual-content",
	"chat-block-child-grooming",
	"chat-block-self-harm",
	"chat-block-anthro",
] as const;
