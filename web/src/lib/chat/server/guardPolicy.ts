// guardPolicy — the typed policy record + shield config for the Shieldstral-1.0-3B sync gate (v2).
//
// POLICY HAS ONE OWNER PER SOURCE (safety-stack invariant): guard enforcement derives from the typed
// record this module serves — `{key, query, action, tier, threshold?}` from the hybrid rules.json —
// never from the COOP_* env sets or prefixes. Those env predicates (moderation.ts isChildBlock /
// isContentBlock) classify COOP results only; no env change can reclassify a guard verdict.
//
// The validator itself lives in guardPolicyCore.mjs so the runtime loader here, the Vitest spec, and
// the vercel-build gate (scripts/check-guard-policy.mjs) share it 1:1 — one validator, three
// consumers. v2 (Shieldstral swap, docs/plans/shieldstral-detection-swap.md): the Llama Guard S-code
// taxonomy is gone. Each rule carries its own yes/no `guard.query`, and a reserved `_shield` block
// carries the global knobs (concurrency, categoryThreshold, operation deadline). The gate runs EVERY
// category query on every unit — no umbrella recall gate (Step-0 calibration found it unreliable).
//
// LAZY, MEMOIZED, NEVER A LOAD-TIME THROW. This module sits in the route's import graph, so a throw
// at import time would take the COOP path down with it and flag-off could not recover. loadGuardPolicy()
// is called behind the guard path and a validation failure memoizes to `null`, which the guard gate
// maps to the documented loud UNKNOWN (error log, child fails closed, unhealthy probe). The build gate
// is where this failure is supposed to be terminal; reaching the null branch in prod means the gate
// was bypassed.

import RULES from "$lib/chat/server/rules.json";
import { validateGuardPolicy } from "$lib/chat/server/guardPolicyCore.mjs";

export type GuardAction = "block" | "log";
export type GuardTier = "child" | "content";

/** One validated guard rule — the single policy record enforcement reads. Its `query` IS the yes/no
 *  detection instruction; `threshold` overrides the shield-wide categoryThreshold when present. */
export type GuardRule = {
	key: string;
	query: string;
	action: GuardAction;
	tier: GuardTier;
	threshold?: number;
	/** Which screens ask this rule's question; absent means both (CUR-2111). */
	screens?: Array<"input" | "output">;
	/** A flag that must be on for the visitor before the input screen asks this rule (CUR-2111). */
	flag?: string;
};

/** The reserved `_shield` config block: the global screening knobs. Internal — consumed only through
 *  `GuardPolicy.shield` in this module. */
type ShieldConfig = {
	instruct: string;
	/** The Instruct used when screening the ASSISTANT's OUTPUT (coop-review-plane Step 3b). Optional in
	 *  rules.json; the validator defaults it to `instruct` when absent, so it is always a non-empty string. */
	outputInstruct: string;
	categoryThreshold: number;
	concurrency: number;
	operationDeadlineMs: number;
};

/** The loaded, validated policy. `byKey` maps a rule key to its record (the fired-key resolver);
 *  `shield` is the compose configuration every screening operation reads. */
export type GuardPolicy = {
	/** File-order entries — child and content tiers intermixed as they appear. */
	entries: GuardRule[];
	byKey: Map<string, GuardRule>;
	shield: ShieldConfig;
};

// ── chunk window (implementation constants, not T&S knobs) ─────────────────────────────────────────
// Re-derived for Shieldstral: the endpoint serves a 32k-token recommended context (max_model_len
// 32768), so a 12k-CHAR document slot (~3–4k tokens) plus the fixed system+Instruct/Query framing
// sits far inside it. 12k also matches the shadow's measured-latency input cap. Overlap covers a
// hazard string spanning a chunk boundary; window − overlap is the stride. Re-derive (don't tune) if
// a smaller served context is ever measured.
export const GUARD_WINDOW_CHARS = 12000;
export const GUARD_OVERLAP_CHARS = 1000;

let cached: GuardPolicy | null | undefined;

/** Load + validate the guard policy from rules.json. Memoized; `null` on validation failure (the
 *  loud-UNKNOWN input for the gate — see the module header). */
export function loadGuardPolicy(): GuardPolicy | null {
	if (cached !== undefined) return cached;
	const { errors, entries, shield } = validateGuardPolicy(RULES);
	if (errors.length > 0 || !shield) {
		console.error(
			"[guard-policy] rules.json failed validation — the guard gate will fail loud (UNKNOWN) until this is fixed:",
			errors
		);
		cached = null;
		return cached;
	}
	const typed = entries as GuardRule[];
	cached = { entries: typed, byKey: new Map(typed.map((e) => [e.key, e])), shield: shield as ShieldConfig };
	return cached;
}

/** Reset the memo. TESTS ONLY. */
export function __resetGuardPolicyForTest(): void {
	cached = undefined;
}

/** The child-tier rules (all `action:"block"` by validator invariant); a partition helper. Every rule
 *  — child and content — is screened on every unit. */
export function childRules(policy: GuardPolicy): GuardRule[] {
	return policy.entries.filter((e) => e.tier === "child");
}

/** The content-tier rules (partition helper for tests / callers). */
export function contentRules(policy: GuardPolicy): GuardRule[] {
	return policy.entries.filter((e) => e.tier === "content");
}

/** The score threshold a rule fires at: its own override, else the shield-wide default. */
export function thresholdFor(policy: GuardPolicy, rule: GuardRule): number {
	return rule.threshold ?? policy.shield.categoryThreshold;
}
