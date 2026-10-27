// guardPolicyCore — the ONE validator + prompt/parse core for the hybrid rules.json guard policy,
// v2: Shieldstral (docs/plans/shieldstral-detection-swap.md).
//
// Deliberately a dependency-free .mjs so its consumers share it 1:1: the runtime loader
// (guardPolicy.ts), the Vitest spec, the build gate (scripts/check-guard-policy.mjs, wired into
// vercel-build), and the Step-0 calibration spike (scripts/shield-calibration.mjs). A validator
// that exists in two copies is two policies; this file is the single interpretation.
//
// v1→v2 (Llama Guard 3 → Shieldstral-1.0-3B): the fixed S-code taxonomy DIES. Shieldstral is a
// per-question judge — fixed system prompt, one <Instruct>/<Query>/<Document> user message, a
// single `yes`/`no` answer, and a renormalised yes/no logprob score. So each rule carries its own
// `guard.query` (a yes/no question) instead of a code/name/policy triple, and the file gains a
// reserved `_shield` block with the global knobs (every category query runs unconditionally — no
// umbrella gate, per Step-0 calibration). Every category is now
// expressible (the v1 guardExempt set existed mostly because Llama Guard had no matching slot);
// the one deliberate exemption left is chat-block-prompt (CUR-54: injection defense is structural).
//
// What lives here:
//   • validateGuardPolicy    — every rule the policy file must satisfy before the guard enforces it,
//                              including the `_shield` reserved-block schema.
//   • SHIELD_SYSTEM_PROMPT   — the model card's fixed system message, verbatim.
//   • buildShieldUserText    — the <Instruct>/<Query>/<Document> user message for a TEXT document.
//                              (Image units append the caption/image parts around the same prefix —
//                              assembled in guardGate, since only the runtime sends images.)
//   • parseShieldAnswerCore  — the strict verdict ladder over one chat-completions response:
//                              logprob score → exact token → UNKNOWN. Never a pass by widening.
//   • neutralizeShieldMarkers — defang <Instruct>/<Query>/<Document> markers inside UNTRUSTED text
//                              so a document cannot impersonate the surrounding structure.

/** v2 enforcement actions. `block` declines the turn; `log` allows it and logs the detection. */
export const GUARD_ACTIONS = ["block", "log"];
/** The screens a rule can be limited to with `guard.screens` (CUR-2111). */
const GUARD_SCREENS = ["input", "output"];

const CHILD_NS = "chat-block-child";
const CONTENT_NS = "chat-block";
/** The one reserved (non-rule) top-level key. Any OTHER `_`-prefixed key is an ERROR — a typo like
 *  `_sheild` must fail the build, never fall through as an exempt-looking rule. */
const SHIELD_KEY = "_shield";

/** Namespace → tier, mirroring moderation.ts's prefix semantics (exact base or `<prefix>-<x>`).
 *  Child is a sub-namespace of content and is checked FIRST. Returns null outside both namespaces —
 *  a guard block on such a key must fail validation loudly, never silently become content tier.
 *  @param {string} key
 *  @returns {"child" | "content" | null} */
export function tierForKey(key) {
	if (key === CHILD_NS || key.startsWith(`${CHILD_NS}-`)) return "child";
	if (key === CONTENT_NS || key.startsWith(`${CONTENT_NS}-`)) return "content";
	return null;
}

/**
 * @typedef {Object} GuardRuleRecord
 * @property {string} key    rules.json key (doubles as the Coop-compatible action name)
 * @property {string} query  the rule's yes/no question — this IS the detection instruction
 * @property {"block" | "log"} action
 * @property {"child" | "content"} tier derived from the key namespace, materialized here
 * @property {number | undefined} threshold optional per-rule score threshold (else _shield.categoryThreshold)
 * @property {Array<"input" | "output">} [screens] which screens ask this rule's question; absent
 *   means both. "input" alone keeps a question about the writer off the assistant's own answer (CUR-2111)
 * @property {string} [flag] a flag key that must be on for the visitor before the input screen
 *   asks this rule; only a caller that evaluated it for the visitor can turn the rule on (CUR-2111)
 */

/**
 * @typedef {Object} ShieldConfigRecord
 * @property {string} instruct
 * @property {string} outputInstruct  Instruct for screening the assistant's OUTPUT; defaults to `instruct`
 * @property {number} categoryThreshold
 * @property {number} concurrency
 * @property {number} operationDeadlineMs
 */

/** @param {unknown} v @returns {v is number} finite, in the OPEN interval (0,1) */
function isThreshold(v) {
	return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
}

/**
 * Validate the `_shield` reserved block.
 * @param {unknown} raw
 * @param {string[]} errors
 * @returns {ShieldConfigRecord | null}
 */
function validateShieldBlock(raw, errors) {
	if (raw === undefined) {
		errors.push(`${SHIELD_KEY}: missing — the global thresholds and knobs live here`);
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${SHIELD_KEY}: must be an object`);
		return null;
	}
	const s = /** @type {Record<string, unknown>} */ (raw);
	const instruct = typeof s.instruct === "string" ? s.instruct.trim() : "";
	if (!instruct) errors.push(`${SHIELD_KEY}.instruct: must be a non-empty string`);
	// outputInstruct is OPTIONAL (coop-review-plane Step 3b): a non-empty string when present, else it
	// defaults to `instruct`. Present-but-empty is an error (a blank Instruct would weaken the output screen).
	const outputInstruct = typeof s.outputInstruct === "string" ? s.outputInstruct.trim() : "";
	if (s.outputInstruct !== undefined && !outputInstruct) {
		errors.push(`${SHIELD_KEY}.outputInstruct: must be a non-empty string when present`);
	}
	if (!isThreshold(s.categoryThreshold)) {
		errors.push(`${SHIELD_KEY}.categoryThreshold: must be a finite number in (0,1)`);
	}
	if (!(typeof s.concurrency === "number" && Number.isInteger(s.concurrency) && s.concurrency > 0)) {
		errors.push(`${SHIELD_KEY}.concurrency: must be a positive integer`);
	}
	// The operation deadline must not undercut a single call's own timeout (guardGate's 8s), or the
	// deadline would abort every call before it could ever answer.
	if (
		!(
			typeof s.operationDeadlineMs === "number" &&
			Number.isInteger(s.operationDeadlineMs) &&
			s.operationDeadlineMs >= 8000
		)
	) {
		errors.push(`${SHIELD_KEY}.operationDeadlineMs: must be an integer ≥ 8000 (the per-call timeout)`);
	}
	if (errors.length > 0) return null;
	return {
		instruct,
		outputInstruct: outputInstruct || instruct,
		categoryThreshold: /** @type {number} */ (s.categoryThreshold),
		concurrency: /** @type {number} */ (s.concurrency),
		operationDeadlineMs: /** @type {number} */ (s.operationDeadlineMs),
	};
}

/**
 * Validate the hybrid rules.json (v2). `_shield` validates as configuration and can never become a
 * rule; any other `_*` key is an error. EVERY rule entry must carry either a `guard` block or an
 * explicit non-empty `guardExempt` reason — under guard-primary an entry with neither is a policy
 * category SILENTLY dropped from the sync gate, which must fail the build, not slip through it.
 * Returns every violation, not just the first, so a build-gate failure lists the full repair job.
 * @param {Record<string, unknown>} rules
 * @returns {{ errors: string[], entries: GuardRuleRecord[], shield: ShieldConfigRecord | null }}
 */
export function validateGuardPolicy(rules) {
	/** @type {string[]} */
	const errors = [];
	/** @type {GuardRuleRecord[]} */
	const entries = [];
	const all = /** @type {Record<string, unknown>} */ (rules ?? {});
	const shield = validateShieldBlock(all[SHIELD_KEY], errors);
	for (const [key, entryRaw] of Object.entries(all)) {
		if (key === SHIELD_KEY) continue;
		if (key.startsWith("_")) {
			errors.push(
				`${key}: unknown reserved key — only "${SHIELD_KEY}" is a valid non-rule entry (typo?)`
			);
			continue;
		}
		const entry = /** @type {{guard?: unknown, guardExempt?: unknown}} */ (entryRaw ?? {});
		const guard = entry?.guard;
		const exempt = entry?.guardExempt;
		if (guard !== undefined && exempt !== undefined) {
			errors.push(
				`${key}: has BOTH guard and guardExempt — pick one (enforced by the guard, or exempt with a reason)`
			);
			continue;
		}
		if (guard === undefined) {
			if (typeof exempt !== "string" || exempt.trim() === "") {
				errors.push(
					`${key}: no guard block and no guardExempt reason — under guard-primary this category would silently vanish from the sync gate; map it or exempt it explicitly`
				);
			}
			continue;
		}
		if (typeof guard !== "object" || guard === null || Array.isArray(guard)) {
			errors.push(`${key}: "guard" must be an object`);
			continue;
		}
		const g = /** @type {Record<string, unknown>} */ (guard);
		const tier = tierForKey(key);
		if (tier === null) {
			// A typo key (outside chat-block-*) must fail loud, not silently become content tier.
			errors.push(
				`${key}: guard-bearing key is outside the "${CONTENT_NS}-*" / "${CHILD_NS}-*" namespaces`
			);
		}
		const query = typeof g.query === "string" ? g.query.trim() : "";
		if (!query) errors.push(`${key}: guard.query must be a non-empty yes/no question`);
		const action = typeof g.action === "string" ? g.action : "";
		if (!GUARD_ACTIONS.includes(action)) {
			errors.push(
				`${key}: guard.action ${JSON.stringify(g.action)} is not one of ${GUARD_ACTIONS.join("|")}`
			);
		} else if (tier === "child" && action !== "block") {
			// Child fails CLOSED everywhere in this stack; a child rule that only logs would be a
			// silent weakening of that contract, so the file cannot express it.
			errors.push(`${key}: a "${CHILD_NS}-*" rule must have guard.action "block", got "${action}"`);
		}
		if (g.threshold !== undefined && !isThreshold(g.threshold)) {
			errors.push(`${key}: guard.threshold must be a finite number in (0,1) when present`);
		}
		const screens = g.screens;
		const screensOk =
			screens === undefined ||
			(Array.isArray(screens) &&
				screens.length > 0 &&
				screens.every((x) => GUARD_SCREENS.includes(x)) &&
				new Set(screens).size === screens.length);
		if (!screensOk) {
			errors.push(`${key}: guard.screens must be a non-empty list of ${GUARD_SCREENS.join("|")} when present`);
		}
		const flag = typeof g.flag === "string" ? g.flag.trim() : "";
		if (g.flag !== undefined && !flag) errors.push(`${key}: guard.flag must be a non-empty flag key when present`);
		if (flag && tier === "child") {
			// A flag that is off would silently drop a child rule, which fails CLOSED everywhere else.
			errors.push(`${key}: a "${CHILD_NS}-*" rule cannot be gated by a flag`);
		}
		if (
			tier !== null &&
			query &&
			GUARD_ACTIONS.includes(action) &&
			(g.threshold === undefined || isThreshold(g.threshold)) &&
			screensOk
		) {
			entries.push({
				key,
				query,
				action: /** @type {"block" | "log"} */ (action),
				tier,
				threshold: /** @type {number | undefined} */ (g.threshold),
				...(screens ? { screens: /** @type {Array<"input" | "output">} */ (screens) } : {}),
				...(flag ? { flag } : {}),
			});
		}
	}
	// An EMPTY guard policy must fail loud, not deploy quiet: with zero entries the compose runs no
	// category queries at all, so nothing is ever screened — total policy removal (a bad
	// rules.json merge) would otherwise ship as a green build. And the child fail-closed contract is
	// only worth anything if a child-tier BLOCK rule exists for the guard to fire.
	if (errors.length === 0 && entries.length === 0) {
		errors.push(
			'no guard-bearing entries: the guard would screen with an EMPTY category set (every turn "safe")'
		);
	}
	if (errors.length === 0 && !entries.some((e) => e.tier === "child" && e.action === "block")) {
		errors.push(
			"no child-tier block rule: the child fail-closed contract has no category to fire (unconditional child queries need at least one)"
		);
	}
	return { errors, entries, shield: errors.length === 0 ? shield : null };
}

// ── prompt core ───────────────────────────────────────────────────────────────────────────────────

/**
 * The document the OUTPUT privacy rule judges: the person's own message in front of the answer chunk,
 * so details they typed about themselves are read as theirs (CUR-1837). Shared with
 * scripts/output-asker-context-calibration.mjs so the probe scores exactly the text the gate sends.
 * @param {string} askerText
 * @param {string} answer
 * @returns {string}
 */
export function withAskerContext(askerText, answer) {
	return `The person asked:\n${askerText}\n\nThe assistant's answer:\n${answer}`;
}

/** The model card's fixed system message, verbatim. vLLM applies Shieldstral's own chat template —
 *  no self-built raw prompt (unlike the Llama Guard /v1/completions path). */
export const SHIELD_SYSTEM_PROMPT =
	'Judge whether the Document meets the requirements based on the Query and the Instruction provided. Note that the answer can only be "yes" or "no".';

/**
 * Defang structure markers inside UNTRUSTED text: `<Instruct>`, `<Query>`, `<Document>` (any case)
 * become inert by inserting a space after `<`, so a document cannot impersonate the surrounding
 * message structure. The text stays readable to the classifier.
 * @param {string} text
 * @returns {string}
 */
export function neutralizeShieldMarkers(text) {
	return String(text).replace(/<(Instruct|Query|Document)\b/gi, "< $1");
}

/**
 * Build the user-message text for ONE text-document judge call. The untrusted document is sliced to
 * `windowChars` BEFORE assembly (instruction/query text is never truncatable), then
 * marker-neutralized, then placed in the single Document slot — the typed-builder contract.
 * For an IMAGE unit the same prefix (through `<Document>: `) is the first content part; the caption
 * and image parts follow (assembled in guardGate).
 * @param {string} instruct
 * @param {string} query
 * @param {string} untrustedText
 * @param {number} windowChars
 * @returns {string}
 */
export function buildShieldUserText(instruct, query, untrustedText, windowChars) {
	const doc = neutralizeShieldMarkers(String(untrustedText).slice(0, windowChars));
	return `<Instruct>: ${instruct}\n<Query>: ${query}\n<Document>: ${doc}\n\n`;
}

// ── strict verdict ladder (plan "Strict verdict parser") ──────────────────────────────────────────

/**
 * @typedef {{kind: "score", score: number, yes: boolean}
 *         | {kind: "token", yes: boolean}
 *         | {kind: "unknown"}} ShieldAnswer
 */

/**
 * Parse ONE chat-completions response under the strict ladder. Each rung either produces a result
 * or falls through; the bottom is UNKNOWN, never a pass:
 *   1. score mode — top_logprobs carries BOTH a `yes` and a `no` token (trimmed, lowercased,
 *      whole-token). score = softmax over exactly those two logits; `yes` = score ≥ threshold
 *      (ties BLOCK).
 *   2. token mode — logprobs unusable, but the completion content, trimmed + lowercased, is exactly
 *      `yes` or exactly `no`. Binary verdict at face value; the caller logs scoreSource="token" as
 *      the audit signal that the threshold was not applied.
 *   3. unknown — anything else. Nothing is normalized beyond trim+lowercase of a whole token:
 *      every widening of the accepted surface widens the PASS surface.
 * @param {{content: string | undefined, topLogprobs: Array<{token?: unknown, logprob?: unknown}> | undefined}} answer
 * @param {number} threshold
 * @returns {ShieldAnswer}
 */
export function parseShieldAnswerCore(answer, threshold) {
	const tops = Array.isArray(answer?.topLogprobs) ? answer.topLogprobs : [];
	let yesLp;
	let noLp;
	for (const t of tops) {
		if (typeof t?.token !== "string" || typeof t?.logprob !== "number" || !Number.isFinite(t.logprob)) {
			continue;
		}
		const tok = t.token.trim().toLowerCase();
		// First occurrence wins — top_logprobs is ranked, so a duplicate token variant further down
		// (e.g. " yes") must not overwrite the canonical entry.
		if (tok === "yes" && yesLp === undefined) yesLp = t.logprob;
		if (tok === "no" && noLp === undefined) noLp = t.logprob;
	}
	if (yesLp !== undefined && noLp !== undefined) {
		const score = Math.exp(yesLp) / (Math.exp(yesLp) + Math.exp(noLp));
		if (!Number.isFinite(score)) return { kind: "unknown" };
		return { kind: "score", score, yes: score >= threshold };
	}
	const content = typeof answer?.content === "string" ? answer.content.trim().toLowerCase() : "";
	if (content === "yes") return { kind: "token", yes: true };
	if (content === "no") return { kind: "token", yes: false };
	return { kind: "unknown" };
}
