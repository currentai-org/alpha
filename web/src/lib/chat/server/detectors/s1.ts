// detectors/s1 — the Zentropi S1 (cope-b-s1) detector for the chat turn's screens (CUR-4527).
// Handed to runGuardScreen as deps.s1 only while the `s1-safety-judge` flag is on (guardGate.ts
// inputJudgesFor). Unlike a JudgeFn, which answers one (target, rule query) call, S1 judges every policy
// of a text chunk in one request, so this answers one CHUNK: a verdict per rules.json rule id. The gate
// keeps chunking, the operation deadline, child fail-closed, the `served` record and everything after the
// hits. Image units stay Shieldstral's, as they do for the CoPE judge.
//
// The request shape:
// `POST /v1/systemone`, each question a `noul` with the model-card wrapper ("Does the content meet the
// criteria described in the following policy?" + the policy) and the two criteria strings. Per chunk:
//   • one BROAD call with every blocking policy of the screen, and one SINGLE call per critical policy,
//     in parallel (plus, on the input screen, one CRISIS call with the three never-block policies);
//   • then single calls for every non-critical policy when a broad score is missing or inside the
//     escalation band [0.1, 0.9], or when a critical policy's broad and single decisions differ;
//   • A-or: a policy is positive when its broad or its single score is at its threshold, unknown when
//     neither is positive and one is missing, else negative.
// A rule id is positive when any of its policies is, else unknown when any is unknown.
//
// An unknown is never a pass. A transport error, a non-2xx, a timeout, a parse error, a served-model
// mismatch or an answer key mismatch leaves that call's policies unknown, and the gate fails closed on a
// child rule as it does today. No retry. One info line per failed call, with the reason, never the text.
import { S1_JUDGE } from "../../../../../config/safetyScreen";
import S1_RULES_RAW from "$lib/chat/server/rules-s1.json";
import type { MinimalLogger } from "$lib/chat/server/guardScreenTypes";
import { z } from "zod";

const headerSchema = z.object({
	instructPrefix: z.string().min(1),
	outputLine: z.string().min(1),
	criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }),
	categoryThreshold: z.number().min(0).max(1),
	escalationBand: z.tuple([z.number(), z.number()]),
	concurrency: z.number().int().positive(),
	timeoutMs: z.number().int().positive(),
	operationDeadlineMs: z.number().int().positive(),
});

const policySchema = z.object({
	ruleId: z.string().regex(/^chat-block-/),
	screen: z.enum(["input", "output", "both"]),
	action: z.enum(["block", "log"]),
	critical: z.boolean(),
	threshold: z.number().min(0).max(1),
	policy: z.string().min(1),
});

type S1Policy = z.infer<typeof policySchema> & { name: string };
type S1Header = z.infer<typeof headerSchema>;
type S1Rules = { header: S1Header; policies: S1Policy[] };

/** Parses at module load, so a bad edit to rules-s1.json fails `pnpm check` and the unit tests, not a turn. */
function parseS1Rules(raw: Record<string, unknown>): S1Rules {
	const { _s1, ...rest } = raw;
	const policies = Object.entries(rest).map(([name, v]) => ({ name, ...policySchema.parse(v) }));
	// A log policy blocks nothing, so it is never critical and never in the broad call.
	for (const p of policies) if (p.action === "log" && p.critical) throw new Error(`rules-s1: log policy ${p.name} is critical`);
	return { header: headerSchema.parse(_s1), policies };
}

export const S1_RULES: S1Rules = parseS1Rules(S1_RULES_RAW as Record<string, unknown>);

export type S1Phase = "input" | "output";
type State = "P" | "N" | "U";

/** The policies a screen asks. Crisis (log) policies are input only by their `screen`. */
export function s1PoliciesFor(phase: S1Phase, rules: S1Rules = S1_RULES): S1Policy[] {
	return rules.policies.filter((p) => p.screen === "both" || p.screen === phase);
}

/** The rule ids a screen can answer: the rules.json rules S1 judges on this phase. */
export function s1RuleIdsFor(phase: S1Phase, rules: S1Rules = S1_RULES): Set<string> {
	return new Set(s1PoliciesFor(phase, rules).map((p) => p.ruleId));
}

/** The content S1 reads: the chunk on input; on output the JSON record of the asker's message and the
 *  answer chunk, as the harness sent it (compact separators, no ASCII escaping). */
function s1Content(phase: S1Phase, text: string, userContext = ""): string {
	return phase === "input" ? text : JSON.stringify({ user_context: userContext, assistant_response: text });
}

/** One question in the model-card wrapper. The output screen adds the line that says what to judge. */
function s1Question(policy: string, phase: S1Phase, header: S1Header = S1_RULES.header) {
	return {
		type: "noul" as const,
		instructions: header.instructPrefix + (phase === "output" ? header.outputLine : "") + policy,
		criteria: header.criteria,
	};
}

function state(score: number | undefined, threshold: number): State {
	return score === undefined ? "U" : score >= threshold ? "P" : "N";
}

function orMerge(a: State, b: State): State {
	return a === "P" || b === "P" ? "P" : a === "U" || b === "U" ? "U" : "N";
}

type S1UnitResult = {
	/** rules.json rule id → its merged state over the S1 policies mapped to it. */
	rules: Map<string, State>;
	/** Every call reached HTTP 2xx with a readable body. */
	httpOk: boolean;
	/** The configured id when an answering call reported the request's model. */
	servedModel?: string;
	servedBackend?: string;
	/** HTTP calls made for this chunk. */
	calls: number;
	escalated: boolean;
};

type S1UnitCtx = { opSignal: AbortSignal; log: MinimalLogger; userContext?: string };

/** One chunk through S1. NEVER rejects: every failure is an unknown state. */
export type S1UnitJudge = (text: string, phase: S1Phase, ctx: S1UnitCtx) => Promise<S1UnitResult>;

export type S1Overrides = {
	fetchImpl?: typeof fetch;
	endpoint?: string;
	key?: string;
	timeoutMs?: number;
	rules?: S1Rules;
};

/** The key, read from the env var the config names (call-time, so tests can stub). */
function s1Key(): string | undefined {
	return process.env[S1_JUDGE.provider.api_key_env] || undefined;
}

export function s1Configured(): boolean {
	return Boolean(s1Key());
}

type CallKind = "broad" | "single" | "escalation" | "crisis";
type CallResult = { scores: Map<string, number>; ok: boolean; servedBackend?: string };

/** A per-chunk cap on in-flight S1 calls. */
class Limiter {
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly limit: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
		else this.active++;
		try {
			return await fn();
		} finally {
			const w = this.waiters.shift();
			if (w) w();
			else this.active--;
		}
	}
}

/** Build the S1 unit judge. Overrides are for tests; all-default reads web/config/safetyScreen.ts,
 *  rules-s1.json and the env key. */
export function makeS1Judge(overrides: S1Overrides = {}): S1UnitJudge {
	const rules = overrides.rules ?? S1_RULES;
	const { header } = rules;
	return async (text, phase, ctx) => {
		const policies = s1PoliciesFor(phase, rules);
		const blocking = policies.filter((p) => p.action === "block");
		const critical = blocking.filter((p) => p.critical);
		const nonCritical = blocking.filter((p) => !p.critical);
		const crisis = policies.filter((p) => p.action === "log");
		const content = s1Content(phase, text, ctx.userContext);
		const limiter = new Limiter(header.concurrency);
		const key = overrides.key ?? s1Key();
		const doFetch = overrides.fetchImpl ?? globalThis.fetch;
		const endpoint = overrides.endpoint ?? `${S1_JUDGE.provider.api_base}/v1/systemone`;
		let calls = 0;
		let httpOk = true;
		let servedBackend: string | undefined;
		let answered = false;

		const unknown = (kind: CallKind, reason: string): CallResult => {
			// The reason only, never the user's text.
			ctx.log.info(
				{ gateSource: "guard", judge: "s1", phase, call: kind, reason },
				"[guard] s1 call not answered — its policies are unknown"
			);
			return { scores: new Map(), ok: false };
		};

		const call = (kind: CallKind, names: S1Policy[]): Promise<CallResult> =>
			limiter.run(async () => {
				// A call whose turn comes after the operation deadline starts no request.
				if (ctx.opSignal.aborted) return unknown(kind, "deadline");
				if (!key) return unknown(kind, "config");
				calls++;
				let res: Response;
				try {
					res = await doFetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
						body: JSON.stringify({
							model: S1_JUDGE.requestModel,
							questions: Object.fromEntries(names.map((p) => [p.name, s1Question(p.policy, phase, header)])),
							state: { content },
						}),
						signal: AbortSignal.any([ctx.opSignal, AbortSignal.timeout(overrides.timeoutMs ?? header.timeoutMs)]),
					});
				} catch (err) {
					httpOk = false;
					const name = (err as { name?: unknown })?.name;
					return unknown(kind, name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
				}
				if (!res.ok) {
					httpOk = false;
					return unknown(kind, `http_${res.status}`);
				}
				let data: { model?: unknown; answers?: unknown; error?: unknown } | null;
				try {
					data = (await res.json()) as typeof data;
				} catch (err) {
					httpOk = false;
					const name = (err as { name?: unknown })?.name;
					return unknown(kind, name === "TimeoutError" || name === "AbortError" ? "timeout" : "parse");
				}
				if (!data || typeof data !== "object") {
					httpOk = false;
					return unknown(kind, "parse");
				}
				if (data.error) return unknown(kind, "endpoint_error");
				if (data.model !== S1_JUDGE.requestModel) return unknown(kind, "served_model_mismatch");
				const answers = data.answers as Record<string, unknown> | undefined;
				const keys = answers && typeof answers === "object" ? Object.keys(answers) : [];
				if (keys.length !== names.length || !names.every((p) => keys.includes(p.name)))
					return unknown(kind, "answer_key_mismatch");
				const scores = new Map<string, number>();
				let invalid = false;
				for (const p of names) {
					const a = answers![p.name] as { type?: unknown; noul?: unknown } | undefined;
					const v = a?.noul;
					if (a?.type === "noul" && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) scores.set(p.name, v);
					else invalid = true;
				}
				if (invalid) unknown(kind, "invalid_score");
				answered = true;
				servedBackend ??= res.url || undefined;
				return { scores, ok: !invalid, servedBackend: res.url || undefined };
			});

		const crisisCall = crisis.length > 0 ? call("crisis", crisis) : undefined;
		const [broad, ...singles] = await Promise.all([
			blocking.length > 0 ? call("broad", blocking) : Promise.resolve<CallResult>({ scores: new Map(), ok: true }),
			...critical.map((p) => call("single", [p])),
		]);
		const single = new Map<string, number>();
		for (const s of singles) for (const [k, v] of s.scores) single.set(k, v);

		const [lo, hi] = header.escalationBand;
		const ambiguous = blocking.some((p) => {
			const b = broad.scores.get(p.name);
			return b === undefined || (b >= lo && b <= hi);
		});
		const conflict = critical.some(
			(p) => state(broad.scores.get(p.name), p.threshold) !== state(single.get(p.name), p.threshold) ||
				!broad.scores.has(p.name) || !single.has(p.name)
		);
		const escalated = ambiguous || conflict;
		if (escalated) {
			const esc = await Promise.all(nonCritical.map((p) => call("escalation", [p])));
			for (const s of esc) for (const [k, v] of s.scores) single.set(k, v);
		}
		const crisisScores = crisisCall ? (await crisisCall).scores : new Map<string, number>();

		const byRule = new Map<string, State>();
		const put = (ruleId: string, s: State) => byRule.set(ruleId, orMerge(byRule.get(ruleId) ?? "N", s));
		for (const p of blocking) {
			const b = state(broad.scores.get(p.name), p.threshold);
			// A policy with no single call keeps its broad state (stack A's decide()).
			put(p.ruleId, single.has(p.name) || p.critical || escalated ? orMerge(b, state(single.get(p.name), p.threshold)) : b);
		}
		for (const p of crisis) put(p.ruleId, state(crisisScores.get(p.name), p.threshold));

		return {
			rules: byRule,
			httpOk,
			...(answered ? { servedModel: S1_JUDGE.model, servedBackend } : {}),
			calls,
			escalated,
		};
	};
}
