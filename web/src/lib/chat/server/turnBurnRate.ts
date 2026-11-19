/**
 * The turn-failure alerts' decision, kept free of the DB and the logger so the replay over
 * Axiom (scripts/replay-turn-alerts.ts) and the unit tests run the same code as the warm cron.
 *
 * MULTI-WINDOW BURN RATE (Google SRE workbook, "Alerting on SLOs", the multiwindow multi-burn-rate
 * table). Burn rate is the failure rate divided by the error budget (1 - SLO); 1.0 spends the budget
 * exactly over the SLO period. A rule fires only when BOTH its long and its short window burn above the
 * rule's rate: the long window says the burn is real, the short one says it is still happening, which is
 * what lets the alert clear minutes after recovery rather than hours, with no second read.
 *
 *   fast  5m and 1h above 14.4x   pages (2% of a 30-day budget gone in an hour)
 *   slow  30m and 6h above 6x     degraded line (5% gone in six hours)
 *
 * THREE SIGNALS, each with its own SLO, chosen from 7 days of production `[turn] outcome` (the
 * replay over Axiom gives the numbers each threshold rests on):
 *
 *   ours      failures in our pipeline, plus any failure written without a layer. Pages.
 *   harm      the visitor got no answer after our own mitigation: every failed turn except the client's.
 *             Lane failover (including Large 3 → Medium on a 429) runs inside the turn, before its
 *             outcome is written, so a failed turn is already one the mitigation did not save.
 *   upstream  per model, failures in the model host. Degraded, naming the models.
 *
 * A long window holding fewer turns than its floor gives no verdict, so 1 failed turn of 2 never pages
 * and a quiet night never clears a firing alert. Fewer failures than the floor's is healthy whatever the
 * rate.
 */
import { FAILURE_OUTCOMES, type TurnOutcome } from "$lib/chat/utils/outcomeLadder";

export type WindowKey = "5m" | "30m" | "1h" | "6h";

export const WINDOW_MS: Record<WindowKey, number> = {
	"5m": 5 * 60_000,
	"30m": 30 * 60_000,
	"1h": 60 * 60_000,
	"6h": 6 * 60 * 60_000,
};

type WindowCounts ={ total: number; bad: number };
export type Windows = Record<WindowKey, WindowCounts>;

export type BurnRule = { name: "fast" | "slow"; short: WindowKey; long: WindowKey; burn: number };

export const BURN_RULES: readonly BurnRule[] = [
	{ name: "fast", short: "5m", long: "1h", burn: 14.4 },
	{ name: "slow", short: "30m", long: "6h", burn: 6 },
];

/**
 * Production over 7 days: 2,562 turns, 0.39% failed in our layer and 3.47% in any layer
 * but the visitor's. Each SLO leaves that week burning under 1x (0.78x and 0.69x), and a page needs 7.2%
 * of the hour's turns failing in our code.
 */
export const OURS_SLO = 0.995;
export const HARM_SLO = 0.95;

export type VolumeFloor = { turns: number; failures: number };
/** Site-wide signals. */
const SITE_FLOOR: VolumeFloor = { turns: 10, failures: 3 };
/** One model's own turns: a partner model sees a few turns an hour, so 3 failed of 3 is already a host
 *  that is not answering. Still never 1 of 2. */
const MODEL_FLOOR: VolumeFloor = { turns: 3, failures: 3 };

export type RuleVerdict =
	/** Too few turns in the long window to call either way. Record nothing. */
	| { kind: "no-verdict"; rule: BurnRule["name"]; long: WindowCounts }
	/** Over in the long window, but the short window saw no turn at all: hold, silence is not recovery. */
	| { kind: "hold"; rule: BurnRule["name"]; burnLong: number }
	| { kind: "over" | "ok"; rule: BurnRule["name"]; burnLong: number; burnShort: number };

const burnOf = (w: WindowCounts, budget: number) => (w.total === 0 ? 0 : w.bad / w.total / budget);

export function ruleVerdict(
	windows: Windows,
	slo: number,
	rule: BurnRule,
	floor: VolumeFloor = SITE_FLOOR
): RuleVerdict {
	const long = windows[rule.long];
	const short = windows[rule.short];
	if (long.total < floor.turns) return { kind: "no-verdict", rule: rule.name, long };
	const budget = 1 - slo;
	const burnLong = burnOf(long, budget);
	const burnShort = burnOf(short, budget);
	if (long.bad < floor.failures || burnLong <= rule.burn)
		return { kind: "ok", rule: rule.name, burnLong, burnShort };
	if (short.total === 0) return { kind: "hold", rule: rule.name, burnLong };
	return { kind: burnShort > rule.burn ? "over" : "ok", rule: rule.name, burnLong, burnShort };
}

/** Both rules for one signal. */
export function burnVerdicts(
	windows: Windows,
	slo: number,
	floor: VolumeFloor = SITE_FLOOR
): Record<BurnRule["name"], RuleVerdict> {
	const [fast, slow] = BURN_RULES.map((r) => ruleVerdict(windows, slo, r, floor));
	return { fast, slow };
}

/** A probe's reading of a set of rule verdicts: unhealthy when any is over, nothing to record when every
 *  one is no-verdict or hold and none is over, healthy otherwise. */
export function probeHealth(verdicts: readonly RuleVerdict[]): boolean | null {
	if (verdicts.some((v) => v.kind === "over")) return false;
	if (verdicts.some((v) => v.kind === "ok")) return true;
	return null;
}

/** One row of the warm cron's aggregate: turns by outcome, layer and model, counted per window. */
export type OutcomeAgg = {
	outcome: string;
	failureLayer: string | null;
	model: string | null;
	counts: Record<WindowKey, number>;
};

const isFailure = (r: OutcomeAgg) => FAILURE_OUTCOMES.has(r.outcome as TurnOutcome);

/** A failure in our layer, or a failure written before the layer existed: unattributed counts as ours. */
export const isOursFailure = (r: OutcomeAgg) =>
	isFailure(r) && (r.failureLayer === "ours" || r.failureLayer === null);
/** The visitor got no answer and it was not their own doing. */
export const isHarm = (r: OutcomeAgg) => isFailure(r) && r.failureLayer !== "client";
const isUpstreamFailure =(r: OutcomeAgg) => isFailure(r) && r.failureLayer === "upstream";

/** Window totals for one signal. Every turn is in the denominator, as it was under the fixed-rate rule. */
export function windowsFor(rows: readonly OutcomeAgg[], isBad: (r: OutcomeAgg) => boolean): Windows {
	const out = {} as Windows;
	for (const k of Object.keys(WINDOW_MS) as WindowKey[]) {
		let total = 0;
		let bad = 0;
		for (const r of rows) {
			total += r.counts[k];
			if (isBad(r)) bad += r.counts[k];
		}
		out[k] = { total, bad };
	}
	return out;
}

/** Models whose own upstream failures are over a burn rule, each judged against its own turns. */
export function upstreamModelsOver(rows: readonly OutcomeAgg[]): {
	over: string[];
	health: boolean | null;
} {
	const byModel = new Map<string, OutcomeAgg[]>();
	for (const r of rows) {
		const m = r.model ?? "unknown";
		byModel.set(m, [...(byModel.get(m) ?? []), r]);
	}
	const over: string[] = [];
	const all: RuleVerdict[] = [];
	for (const [model, mine] of byModel) {
		const v = Object.values(burnVerdicts(windowsFor(mine, isUpstreamFailure), HARM_SLO, MODEL_FLOOR));
		all.push(...v);
		if (v.some((x) => x.kind === "over")) over.push(model);
	}
	over.sort();
	return { over, health: over.length > 0 ? false : probeHealth(all) };
}
