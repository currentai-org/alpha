// detectors/zentropi — the Zentropi CoPE-B detector adapter for the chat turn's input screen (CUR-4340).
// ONE JudgeFn, handed to runGuardScreen as deps.judge by inputJudgeFor (guardGate.ts) only for a turn
// whose typed text is one of the routed languages in web/config/safetyScreen.ts. The gate keeps the
// rules, chunking, the deadline, child fail-closed and the `served` record; this file answers one
// (target, rule query) call. A turn the detector ranks as a routed language without clearing its margin
// keeps Shieldstral as the judge and gets this model as a second opinion (makeCopeSecondOpinion, CUR-4423).
//
// The model is zentropi-ai/cope-b-a4b on our own Hugging Face Inference Endpoint (vLLM, OpenAI chat
// completions). Its model card's prompt, as the one user turn: the POLICY is the rule's query, the
// CONTENT the chunk, and the answer one token, "1" or "0".
//
// Any call it does not answer — an image unit, a non-2xx, a network error, a reply that is not "0"/"1",
// or no answer within the 5 s timeout — goes to the fallback judge (Shieldstral) with no retry, under the
// same operation deadline. A refused or failed call falls back at once; a stalled one only after its
// 5 s. One chunk's 16 calls on 6 workers is 3 rounds, about 16 s under a full stall, inside the 20 s
// floor; a paste of about 5 chunks or more can pass the 100 s cap and close as couldn't-check.
import { ZENTROPI_JUDGE } from "../../../../../config/safetyScreen";
import type { JudgeFn, JudgeOutcome } from "$lib/chat/server/guardScreenTypes";
import { shieldstralJudge } from "./shieldstral";

/** The key, read from the env var the config names (call-time, so tests can stub). */
function zentropiKey(): string | undefined {
	return process.env[ZENTROPI_JUDGE.provider.api_key_env] || undefined;
}

export function zentropiConfigured(): boolean {
	return Boolean(zentropiKey());
}

/** The CoPE-B input format from the zentropi-ai/cope-b-a4b model card, verbatim. */
function copePrompt(policy: string, content: string): string {
	return (
		'Examine the given POLICY and determine if the given CONTENT meets the criteria for ANY of the LABELS. Answer "1" if yes, and "0" if no.' +
		`\n\n\nPOLICY\n======\n\n${policy}\n\n\nCONTENT\n=======\n\n${content}`
	);
}

export type ZentropiOverrides = {
	fetchImpl?: typeof fetch;
	endpoint?: string;
	key?: string;
	timeoutMs?: number;
	fallback?: JudgeFn;
};

type FallbackReason = "http" | "timeout" | "network" | "parse" | "config";

/** Build a CoPE-B JudgeFn. Overrides are for tests; all-default reads web/config/safetyScreen.ts and
 *  the env key. NEVER rejects: every failure resolves through the fallback judge. */
export function makeZentropiJudge(overrides: ZentropiOverrides = {}): JudgeFn {
	const fallback = overrides.fallback ?? shieldstralJudge;
	return async (target, query, threshold, ctx): Promise<JudgeOutcome> => {
		if (ctx.opSignal.aborted) return { answer: { kind: "unknown" }, httpOk: false };
		// CoPE-B is text only; an image unit is Shieldstral's, as on every other turn.
		if (target.kind === "image") return fallback(target, query, threshold, ctx);
		const fallBack = (reason: FallbackReason) => {
			// The reason only, never the user's text.
			ctx.log.info(
				{ gateSource: "guard", judge: "zentropi", fallback: "shieldstral", reason },
				"[guard] zentropi call not answered — this call screens with Shieldstral"
			);
			return fallback(target, query, threshold, ctx);
		};
		const key = overrides.key ?? zentropiKey();
		if (!key) return fallBack("config");
		const doFetch = overrides.fetchImpl ?? globalThis.fetch;
		const endpoint = overrides.endpoint ?? `${ZENTROPI_JUDGE.provider.api_base}/v1/chat/completions`;
		let res: Response;
		try {
			res = await doFetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: ZENTROPI_JUDGE.model,
					messages: [{ role: "user", content: copePrompt(query, target.text) }],
					max_tokens: 1,
					temperature: 0,
					stream: false,
				}),
				signal: AbortSignal.any([ctx.opSignal, AbortSignal.timeout(overrides.timeoutMs ?? ZENTROPI_JUDGE.timeoutMs)]),
			});
		} catch (err) {
			const name = (err as { name?: unknown })?.name;
			return fallBack(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
		}
		if (!res.ok) return fallBack("http");
		let data: { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null;
		try {
			data = (await res.json()) as typeof data;
		} catch (err) {
			const name = (err as { name?: unknown })?.name;
			return fallBack(name === "TimeoutError" || name === "AbortError" ? "timeout" : "parse");
		}
		const content = data?.choices?.[0]?.message?.content;
		const label = typeof content === "string" ? content.trim() : undefined;
		if (label !== "1" && label !== "0") return fallBack("parse");
		// A label, not a score: `threshold` does not apply.
		return {
			answer: { kind: "token", yes: label === "1" },
			httpOk: true,
			servedModel: typeof data?.model === "string" ? data.model : undefined,
			servedBackend: res.url || undefined,
		};
	};
}

/** No answer, and no request: a CoPE call the second opinion could not get. */
const noSecondOpinion: JudgeFn = async () => ({ answer: { kind: "unknown" }, httpOk: false });

/** CoPE-B as a SECOND opinion beside the Shieldstral screen (CUR-4423), given to runGuardScreen as
 *  deps.alsoJudge for a near-miss turn. A call CoPE does not answer is unknown, never a Shieldstral call:
 *  Shieldstral's own screen of the same turn already covers it, and the gate drops the second screen's
 *  unknowns. */
export function makeCopeSecondOpinion(overrides: Omit<ZentropiOverrides, "fallback"> = {}): JudgeFn {
	return makeZentropiJudge({ ...overrides, fallback: noSecondOpinion });
}
