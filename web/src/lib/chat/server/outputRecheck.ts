// Output re-check on a hit (CUR-3975). The output screen judges each batch of an answer on its own: a
// few hundred characters, 200 characters of the text before it, and no question. Shieldstral reads that
// fragment strictly, so an answer that quotes a stereotype in order to criticise it ("a robot decides
// girls are not good at maths… that is not fair") scores high on chat-block-toxic and is cut,
// while the same paragraph scores much lower with the question in front of it and lowest inside the
// whole answer. A closing paragraph in Yoruba behaves the same way.
//
// So when a batch is flagged, the rules that fired are asked once more, about the question and the whole
// answer so far, before the answer is cut. The first screen stays the fast, narrow check that every
// batch passes, so streaming and time to first token do not change; only a flagged batch pays for the
// second call. Thresholds and the output instruct are unchanged, and the second call goes to the same
// Shieldstral endpoint as the first, so no new processor reads the answer.
//
// The re-check can only lift a block, never add one, and it fails closed: a "yes", an UNKNOWN, an error
// or a timeout leaves the block standing. It never looks at a child-safety hit, a check that could not
// finish, or a self-harm hit (whose decline is crisis support). The rules that fired stay in `hits`, so
// the review plane still sees what the first screen said.
//
// It runs wherever the output screen runs, so OUTPUT_MODERATION governs both.

import { logger as defaultLogger } from "$lib/chat/server/logger";
import { ASKER_CONTEXT_CAP, getGuardVerdict, withEntries, type GuardScreenDeps } from "$lib/chat/server/guardGate";
import { withAskerContext } from "$lib/chat/server/guardPolicyCore.mjs";
import { GUARD_WINDOW_CHARS, loadGuardPolicy, type GuardPolicy } from "$lib/chat/server/guardPolicy";
import { textOnlyGuardInput, type JudgeFn } from "$lib/chat/server/guardScreenTypes";
import { SHIELDSTRAL_MODEL, shieldstralJudge } from "$lib/chat/server/detectors/shieldstral";
import { isSupportRule } from "$lib/chat/server/ruleLabel";
import type { OutputScreenResult } from "$lib/chat/server/moderation";

/** Upper bound on the whole re-check. A flagged batch waits for it; the screen stream passes less when its
 *  own window has less left. On expiry the block stands. */
const RECHECK_TIMEOUT_MS = 6_000;
// The judge reads the first GUARD_WINDOW_CHARS of its document, so the answer goes in cut from the front,
// after the question and its header. The flagged batch must fit whole; the answer before it fills the rest.
const ANSWER_TAIL_CHARS = GUARD_WINDOW_CHARS - ASKER_CONTEXT_CAP - 500;

/** The re-check a screen stream calls on a flagged batch: the answer before the batch, the batch, the first
 *  screen's result, and the time the stream's window has left; the verdict to act on comes back. */
export type OutputRecheck = (
	prior: string,
	batch: string,
	first: OutputScreenResult,
	budgetMs: number
) => Promise<OutputScreenResult>;

type RecheckOutcome = "cleared" | "upheld" | "failed" | "skipped-long";

type MinimalLogger = { info: (o: unknown, m: string) => void };

/** The block rule keys a first-screen result may be re-checked on, or null when it may not be: a child
 *  hit, a check that could not finish, a child query left unanswered beside a content block, a self-harm
 *  hit, or a block whose rule is not among its hits. */
function recheckRules(first: OutputScreenResult): string[] | null {
	if (!first.blocked || first.kind !== "content_policy" || first.unscreened || first.childUnknown || !first.category)
		return null;
	const blocks = (first.hits ?? []).filter((h) => h.action === "block");
	if (blocks.length === 0 || !blocks.some((h) => h.key === first.category)) return null;
	if (blocks.some((h) => h.tier !== "content" || isSupportRule(h.key))) return null;
	return [...new Set(blocks.map((h) => h.key))];
}

/**
 * Re-checks a flagged output batch with the question and the whole answer so far. Never throws, and
 * returns `first` unchanged unless every block rule that fired answers a clear no. Logs one line with the
 * outcome, the rules and the timing, never the text.
 */
export async function recheckOutputBlock(
	prior: string,
	batch: string,
	first: OutputScreenResult,
	deps: Pick<GuardScreenDeps, "judge" | "logger"> & {
		askerText?: string;
		policy?: GuardPolicy | null;
		timeoutMs?: number;
		now?: () => number;
	} = {}
): Promise<OutputScreenResult> {
	const keys = recheckRules(first);
	if (!keys) return first;
	const log: MinimalLogger = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => Date.now());
	const started = now();
	const done = (outcome: RecheckOutcome, result: OutputScreenResult) => {
		log.info(
			{ outcome, rules: keys, ms: Math.round(now() - started), chars: prior.length + batch.length },
			"[output-recheck] batch"
		);
		return result;
	};
	const policy = deps.policy !== undefined ? deps.policy : loadGuardPolicy();
	const rules = policy?.entries.filter((r) => keys.includes(r.key)) ?? [];
	// A key the policy no longer holds cannot be asked, so its block stands.
	if (!policy || rules.length !== keys.length) return done("failed", first);

	// A batch the judge cannot read whole is never cleared on a part of it.
	if (batch.length > ANSWER_TAIL_CHARS) return done("skipped-long", first);
	const room = ANSWER_TAIL_CHARS - batch.length;
	const answer = (room > 0 ? prior.slice(-room) : "") + batch;
	const asker = deps.askerText?.trim().slice(0, ASKER_CONTEXT_CAP) ?? "";
	const doc = asker ? withAskerContext(asker, answer) : answer;
	// Whole milliseconds: AbortSignal.timeout refuses a fraction, which would fail every judge call.
	const timeoutMs = Math.floor(Math.min(RECHECK_TIMEOUT_MS, deps.timeoutMs ?? RECHECK_TIMEOUT_MS));
	if (timeoutMs <= 0) return done("failed", first);
	// One deadline for the whole operation, at the re-check's own bound: it aborts the calls in flight
	// and resolves any still queued as UNKNOWN without a request, so no call outlives the re-check.
	const asked = withEntries(policy, rules);
	// Only a score under the threshold lifts a block. A bare "no" without logprobs never had the threshold
	// applied, so here it counts as no answer. Each rule's scored "no" is recorded, so a rule the screen
	// never asked cannot count as cleared.
	const judge = deps.judge ?? shieldstralJudge;
	const scoredNo = new Set<string>();
	const scoredOnly: JudgeFn = async (target, query, threshold, ctx) => {
		const o = await judge(target, query, threshold, ctx);
		if (o.answer.kind === "token") return { ...o, answer: { kind: "unknown" } };
		if (o.answer.kind === "score" && !o.answer.yes) scoredNo.add(query);
		return o;
	};
	const bounded = { ...asked, shield: { ...asked.shield, operationDeadlineMs: timeoutMs } };
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		timer.unref?.();
	});
	try {
		const g = await Promise.race([
			getGuardVerdict(textOnlyGuardInput(doc), {
				judge: scoredOnly,
				logger: deps.logger,
				screen: "output",
				instruct: policy.shield.outputInstruct,
				policy: bounded,
				deadlineClosesContent: false,
				timeoutMs,
				deadlineCapMs: timeoutMs,
			}).catch(() => null),
			expired,
		]);
		if (!g || g.verdict.status !== "ok" || g.childSafety.flagged) return done("failed", first);
		if (g.contentPolicy.action === "block") return done("upheld", first);
		if (!rules.every((r) => scoredNo.has(r.query))) return done("failed", first);
		return done("cleared", { blocked: false, kind: null, hits: first.hits });
	} finally {
		clearTimeout(timer);
	}
}

// ── the output_screen_recheck_clears fault (preview only, faultInjection.ts) ───────────────────────
const FAULT_RULE = "chat-block-toxic";

/** The fault's first screen: every batch flagged on one content rule, with no hit, so nothing the fault
 *  makes up ever reaches the ledger the Coop report reads. */
export function recheckFaultFlag(): OutputScreenResult {
	return { blocked: true, kind: "content_policy", category: FAULT_RULE, hits: [] };
}

/** The fault's judge: a clear "no" to every question, without a call to the endpoint. */
const recheckFaultJudge: JudgeFn = async () => ({
	answer: { kind: "score", score: 0, yes: false },
	httpOk: true,
	servedModel: SHIELDSTRAL_MODEL,
});

/** The fault's re-check: the real re-check on the fault's rule, answered by the stub judge. The hit it
 *  needs is added here and taken off its result, so it never reaches the ledger either. */
export async function recheckFault(
	prior: string,
	batch: string,
	first: OutputScreenResult,
	deps: { askerText?: string; timeoutMs?: number } = {}
): Promise<OutputScreenResult> {
	const withHit = { ...first, hits: [{ key: FAULT_RULE, action: "block" as const, tier: "content" as const }] };
	const r = await recheckOutputBlock(prior, batch, withHit, { ...deps, judge: recheckFaultJudge });
	return r === withHit ? first : { ...r, hits: [] };
}
