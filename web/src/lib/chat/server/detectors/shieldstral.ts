// detectors/shieldstral — the Shieldstral-1.0-3B detector adapter (coop-review-plane Step 5).
//
// ONE JudgeFn behind ONE seam: runGuardScreen (guardGate.ts) calls `deps.judge ?? shieldstralJudge`, so
// the detector is swappable by providing a different JudgeFn — a future detector is a NEW file
// implementing JudgeFn plus its expected model id, no registry and no config-driven selection (YAGNI).
//
// This adapter owns everything Shieldstral-specific: the endpoint (OpenAI /v1/chat/completions — vLLM
// applies Shieldstral's own chat template), the token / bill-to, the served-model id, and the
// request/response shape (per-question yes/no judge with a renormalised yes/no logprob score). The gate
// keeps chunking, unit fan-out, the semaphore, the deadline, the merge precedence, the deriver, and the
// health probe. Adapter-specific config (fetchImpl/endpoint/token/billTo/model) is passed to the factory
// here, NOT on the gate's GuardScreenDeps — the specs build a judge via makeShieldstralJudge({...}).
import {
	SHIELD_SYSTEM_PROMPT,
	buildShieldUserText,
	parseShieldAnswerCore,
} from "$lib/chat/server/guardPolicyCore.mjs";
import { GUARD_WINDOW_CHARS } from "$lib/chat/server/guardPolicy";
import {
	IMAGE_CAPTION_CAP,
	type JudgeFn,
	type JudgeOutcome,
	type ShieldAnswer,
} from "$lib/chat/server/guardScreenTypes";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { guardRefreshDue } from "./guardRefresh";

/**
 * A scenario run's guard calls, input and output screen alike, replay from the model replay
 * store, so CI stops queueing on the guard GPU www shares. The key is the whole request (guard model,
 * instruct, rule query, text), so a changed rule or model is a miss, never a stale verdict. Mock mode
 * goes live and records instead, because a mock answer parses as UNKNOWN and would fail the child tier
 * closed. A none-mode miss answers 599, which the judge reads as UNKNOWN.
 *
 * A `@real-screen` spec on a develop push, nightly or promotion run asks for the live guard
 * (`guardLive`): a stored verdict is refreshed live when `guardRefreshDue` says so, and replays
 * otherwise (SOL-267), so the live screen drifting on identical input is caught within a few days
 * without every develop run sending ~300 screens to the GPU www shares. PR runs replay what it said last.
 * Outside a scenario request, and always in production (neither is set without the fault-inject
 * token), this is plain `fetch`. (SOL-258)
 */
async function guardReplayFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	const context = getRequestContext();
	// Never a loose key: the guard's calls for one text differ by category in the system prompt alone,
	// so a loose match would replay another category's verdict. `nearest` keys exactly here.
	const mode =
		context?.guardLive || context?.replayMode === "mock" || context?.replayMode === "nearest"
			? "new_episodes"
			: context?.replayMode;
	if (!mode) return globalThis.fetch(url, init);
	const { replayOrRecord } = await import("$lib/chat/server/endpoints/openai/modelReplay");
	const refreshDue = context?.guardLive ? guardRefreshDue : undefined;
	return replayOrRecord(url, init, (i) => globalThis.fetch(url, i), { guard: true }, mode, { refreshDue });
}

// ── env / config (call-time, so tests can stub) ────────────────────────────────────────────────────
// GUARD_SHADOW_URL names the Shieldstral endpoint: an OpenAI chat/completions base.
export function shieldstralBase(): string | undefined {
	return process.env.GUARD_SHADOW_URL?.replace(/\/+$/, "") || undefined;
}
/** OpenAI chat/completions route — vLLM applies Shieldstral's own chat template (no self-built raw
 *  prompt, unlike the Llama Guard /v1/completions path). */
export function shieldstralEndpoint(): string | undefined {
	const base = shieldstralBase();
	return base ? `${base}/v1/chat/completions` : undefined;
}
function shieldstralToken(): string | undefined {
	return process.env.HF_TOKEN || process.env.OPENAI_API_KEY || undefined;
}
function shieldstralBillTo(): string | undefined {
	return process.env.HF_BILL_TO || undefined;
}
/** True once the Shieldstral endpoint is addressed (GUARD_SHADOW_URL set) — the gate's misconfig check
 *  (invariant 5: flag/config decides on/off, this is the address). */
export function shieldstralConfigured(): boolean {
	return Boolean(shieldstralBase());
}

/** The served-model id the health probe asserts on EVERY response (one adapter, one expected id). */
export const SHIELDSTRAL_MODEL = "mistralai/Shieldstral-1.0-3B";

export type ShieldstralOverrides = {
	fetchImpl?: typeof fetch;
	endpoint?: string;
	token?: string;
	billTo?: string;
	model?: string;
};

/** Build a Shieldstral JudgeFn. Overrides (tests, the shadow) replace the env-read config per field;
 *  all-default is `shieldstralJudge`. NEVER rejects: a failure/garble is an UNKNOWN answer, and a call
 *  whose turn comes after the operation deadline resolves UNKNOWN WITHOUT starting a request. */
export function makeShieldstralJudge(overrides: ShieldstralOverrides = {}): JudgeFn {
	return async (target, query, threshold, ctx): Promise<JudgeOutcome> => {
		if (ctx.opSignal.aborted) return { answer: { kind: "unknown" }, httpOk: false };
		const doFetch = overrides.fetchImpl ?? guardReplayFetch;
		const endpoint = overrides.endpoint ?? shieldstralEndpoint();
		if (!endpoint) return { answer: { kind: "unknown" }, httpOk: false };
		const token = overrides.token ?? shieldstralToken();
		const billTo = overrides.billTo ?? shieldstralBillTo();

		const messages =
			target.kind === "text"
				? [
						{ role: "system", content: SHIELD_SYSTEM_PROMPT },
						{ role: "user", content: buildShieldUserText(ctx.instruct, query, target.text, GUARD_WINDOW_CHARS) },
					]
				: [
						{ role: "system", content: SHIELD_SYSTEM_PROMPT },
						{
							role: "user",
							// Caption (a bounded finalText prefix of the SOURCE message) BEFORE the image, mirroring
							// the endpoint's own part order — the text-image-text sandwich the model card wants.
							content: [
								{ type: "text", text: buildShieldUserText(ctx.instruct, query, target.image.caption, IMAGE_CAPTION_CAP) },
								{ type: "image_url", image_url: { url: `data:${target.image.mime};base64,${target.image.screenB64}` } },
								{ type: "text", text: "\n\n" },
							],
						},
					];

		try {
			const res = await doFetch(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(billTo ? { "X-HF-Bill-To": billTo } : {}),
				},
				body: JSON.stringify({
					model: overrides.model ?? SHIELDSTRAL_MODEL,
					messages,
					max_tokens: 1,
					temperature: 0,
					logprobs: true,
					top_logprobs: 20,
					stream: false,
				}),
				signal: AbortSignal.any([ctx.opSignal, AbortSignal.timeout(ctx.timeoutMs)]),
			});
			if (!res.ok) return { answer: { kind: "unknown" }, httpOk: false };
			let data: {
				model?: unknown;
				choices?: Array<{
					message?: { content?: unknown };
					logprobs?: { content?: Array<{ top_logprobs?: unknown }> };
				}>;
			};
			try {
				data = (await res.json()) as typeof data;
			} catch {
				// Transport delivered A body; it just wasn't a verdict — parse-level unknown, transport ok.
				return { answer: { kind: "unknown" }, httpOk: true };
			}
			const choice = data?.choices?.[0];
			const content = typeof choice?.message?.content === "string" ? choice.message.content : undefined;
			const tops = choice?.logprobs?.content?.[0]?.top_logprobs;
			const topLogprobs = Array.isArray(tops)
				? (tops as Array<{ token?: unknown; logprob?: unknown }>)
				: undefined;
			const answer = parseShieldAnswerCore({ content, topLogprobs }, threshold) as ShieldAnswer;
			if (answer.kind === "token") {
				// The audit signal that logprobs were unavailable on this call, so the threshold was NOT
				// applied — a face-value yes/no. Query text is our own policy, not user content.
				ctx.log.info(
					{ gateSource: "guard", scoreSource: "token", query },
					"[guard] token-mode verdict (logprobs unavailable — threshold not applied)"
				);
			}
			return {
				answer,
				httpOk: true,
				servedModel: typeof data?.model === "string" ? data.model : undefined,
				// From the response, so a test double or a redirect reports where the call really went.
				servedBackend: res.url || undefined,
				servedProvider: res.headers?.get?.("x-inference-provider") ?? undefined,
			};
		} catch {
			// Network error / op-deadline or per-call abort — could not reach a verdict.
			return { answer: { kind: "unknown" }, httpOk: false };
		}
	};
}

/** The default Shieldstral detector — reads env config. runGuardScreen uses this unless deps.judge overrides. */
export const shieldstralJudge: JudgeFn = makeShieldstralJudge();
