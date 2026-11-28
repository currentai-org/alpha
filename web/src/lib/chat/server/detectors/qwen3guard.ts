// detectors/qwen3guard — the Qwen3Guard-Gen-0.6B detector adapter.
//
// Qwen3Guard's chat template holds its whole policy, so one call screens a text unit against every
// category at once and answers `Safety: Safe|Unsafe|Controversial` plus a category list. The gate asks
// the detector one (unit, rule) pair at a time, so this adapter makes ONE call per unit, caches it for
// the unit's other rule questions, and answers each rule from the categories through RULE_CATEGORIES.
// The cache is keyed on the unit object the gate hands every one of a screen's rule calls, so a verdict
// never outlives the screen and never crosses turns.
//
// What it cannot do is written next to the map and in selfhost/README.md: no anthropomorphism category,
// no child-specific category, no method-versus-distress split for self-harm. The paired screen
// (detectors/safetyScreen.ts) keeps those four rules on Shieldstral; this adapter answers them only in
// the explicit `qwen3guard-only` mode.
import { loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import type { JudgeFn, JudgeOutcome, JudgeTarget } from "$lib/chat/server/guardScreenTypes";

/** The served-model id the health probe asserts: the `--alias` the compose service sets. */
export const QWEN3GUARD_MODEL = "Qwen/Qwen3Guard-Gen-0.6B";

/** Qwen3Guard's category labels, as one id each. `ignored` labels fire nothing: they are not in
 *  rules.json, and "Politically Sensitive Topics" would decline political questions. */
type QwenCategory =
	| "violent"
	| "illegal"
	| "sexual"
	| "pii"
	| "self-harm"
	| "unethical"
	| "ignored"
	| "none"
	| "unrecognised";

export type QwenVerdict = { verdict: "safe" | "unsafe" | "controversial"; categories: QwenCategory[] };

export function categoryOf(label: string): QwenCategory {
	const l = label.trim().toLowerCase();
	if (!l) return "unrecognised";
	// "non-violent" first: it contains "violent".
	if (/^non-?violent/.test(l)) return "illegal";
	if (l.startsWith("violent")) return "violent";
	if (l.startsWith("sexual")) return "sexual";
	if (l.startsWith("pii") || l.startsWith("personal")) return "pii";
	if (l.startsWith("suicide")) return "self-harm";
	if (l.startsWith("unethical")) return "unethical";
	if (l.startsWith("politic") || l.startsWith("copyright") || l.startsWith("jailbreak")) return "ignored";
	if (l === "none") return "none";
	return "unrecognised";
}

/** Parse `Safety: Unsafe\nCategories: Violent, PII`. Null when the first line is not a verdict. */
export function parseQwen3GuardOutput(content: unknown): QwenVerdict | null {
	if (typeof content !== "string") return null;
	const m = /safety:\s*(safe|unsafe|controversial)/i.exec(content);
	if (!m) return null;
	const cat = /categor(?:y|ies):\s*([^\n]*)/i.exec(content);
	const categories = cat ? cat[1].split(/[,;]/).map(categoryOf) : [];
	return { verdict: m[1].toLowerCase() as QwenVerdict["verdict"], categories };
}

// rules.json rule key → the Qwen3Guard categories that fire it. A rule that is absent never fires from
// this model. Rules that read coarsely are the ones the README names:
//  - self-harm-eating: any self-harm label (no eating-specific one).
//  - self-harm-intent / -passive / -hedged: none. They only log, and Qwen3Guard has no label for them.
//  - harassment, toxic, hate, hate-advocacy: all "Unethical Acts", so one hit fires all four.
//  - fraud: "Non-violent Illegal Acts" with no carve-out for made-up sample data, so a request for fake
//    test records can read as PII or illegal.
//  - the two child rules: no child-specific label; qwen3guard-only mode reads Sexual Content and
//    Unethical Acts as "could not tell" (unknown), which the gate fails closed on.
//  - anthro: no label, never fires.
const RULE_CATEGORIES: Record<string, QwenCategory[]> = {
	"chat-block-violence": ["violent"],
	"chat-block-self-harm": ["self-harm"],
	"chat-block-self-harm-eating": ["self-harm"],
	"chat-block-sexual": ["sexual"],
	"chat-block-drugs": ["illegal"],
	"chat-block-harrasment": ["unethical"],
	"chat-block-toxic": ["unethical"],
	"chat-block-privacy": ["pii"],
	"chat-block-fraud": ["illegal"],
	"chat-block-hate": ["unethical"],
	"chat-block-hate-advocacy": ["unethical"],
};
const CHILD_UNKNOWN_CATEGORIES: QwenCategory[] = ["sexual", "unethical"];
const CHILD_RULES = new Set(["chat-block-child-sexual-content", "chat-block-child-grooming"]);

/** The rule keys this map covers or reads as unknown for a child rule: every rule key the policy asks
 *  must be in here or be one the map deliberately never fires (spec pins the list). */
export const QWEN_MAPPED_RULES = Object.keys(RULE_CATEGORIES);

export type QwenRuleState = "yes" | "no" | "unknown";

/** One rule's answer from a parsed verdict. Safe and Controversial answer no everywhere (a borderline
 *  label is not a block; strict handling of it is a trust-and-safety decision). An Unsafe verdict with no
 *  category the adapter recognises (including "None") is unknown, never a pass. */
export function ruleState(ruleKey: string, v: QwenVerdict): QwenRuleState {
	if (v.verdict !== "unsafe") return "no";
	const known = v.categories.filter((c) => c !== "unrecognised" && c !== "none");
	if (known.length === 0) return "unknown";
	if (CHILD_RULES.has(ruleKey)) return known.some((c) => CHILD_UNKNOWN_CATEGORIES.includes(c)) ? "unknown" : "no";
	const fires = RULE_CATEGORIES[ruleKey];
	return fires && known.some((c) => fires.includes(c)) ? "yes" : "no";
}

function qwen3guardBase(): string | undefined {
	return process.env.QWEN3GUARD_URL?.replace(/\/+$/, "") || undefined;
}
export function qwen3guardConfigured(): boolean {
	return Boolean(qwen3guardBase());
}

export type Qwen3GuardOverrides = { fetchImpl?: typeof fetch; endpoint?: string; model?: string };

type Call = { verdict: QwenVerdict | null; httpOk: boolean; servedModel?: string; servedBackend?: string };

/** Build the Qwen3Guard JudgeFn. NEVER rejects: a failure or garble is an unknown answer, and a call that
 *  comes after the operation deadline resolves unknown without starting a request. A picture is never
 *  screened here (the model reads text), so an image unit is unknown. */
export function makeQwen3GuardJudge(overrides: Qwen3GuardOverrides = {}): JudgeFn {
	const calls = new WeakMap<JudgeTarget, Promise<Call>>();
	let queryToKey: Map<string, string> | undefined;
	const keyOf = (query: string) => {
		if (!queryToKey) {
			queryToKey = new Map((loadGuardPolicy()?.entries ?? []).map((r) => [r.query, r.key]));
		}
		return queryToKey.get(query);
	};
	const unknown = (httpOk: boolean): JudgeOutcome => ({ answer: { kind: "unknown" }, httpOk });

	return async (target, query, _threshold, ctx): Promise<JudgeOutcome> => {
		if (ctx.opSignal.aborted || target.kind !== "text") return unknown(target.kind !== "text");
		const endpoint = overrides.endpoint ?? (qwen3guardBase() ? `${qwen3guardBase()}/v1/chat/completions` : undefined);
		const key = keyOf(query);
		if (!endpoint || !key) return unknown(false);

		let call = calls.get(target);
		if (!call) {
			call = (async (): Promise<Call> => {
				try {
					const doFetch = overrides.fetchImpl ?? globalThis.fetch;
					const res = await doFetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: overrides.model ?? QWEN3GUARD_MODEL,
							messages: [{ role: "user", content: target.text }],
							max_tokens: 32,
							temperature: 0,
							stream: false,
						}),
						signal: AbortSignal.any([ctx.opSignal, AbortSignal.timeout(ctx.timeoutMs)]),
					});
					if (!res.ok) return { verdict: null, httpOk: false };
					let data: { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
					try {
						data = (await res.json()) as typeof data;
					} catch {
						return { verdict: null, httpOk: true };
					}
					return {
						verdict: parseQwen3GuardOutput(data?.choices?.[0]?.message?.content),
						httpOk: true,
						servedModel: typeof data?.model === "string" ? data.model : undefined,
						servedBackend: res.url || undefined,
					};
				} catch {
					return { verdict: null, httpOk: false };
				}
			})();
			calls.set(target, call);
		}
		const c = await call;
		const base = { httpOk: c.httpOk, servedModel: c.servedModel, servedBackend: c.servedBackend };
		if (!c.verdict) return { answer: { kind: "unknown" }, ...base };
		const s = ruleState(key, c.verdict);
		return s === "unknown" ? { answer: { kind: "unknown" }, ...base } : { answer: { kind: "token", yes: s === "yes" }, ...base };
	};
}
