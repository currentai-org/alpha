// Crisis / self-harm signal — a FLOOR, not a classifier.
//
// Why this exists: the moderation seam screens INPUT for content/child/injection (server seam,
// src/lib/chat/server/moderation.ts); nothing
// screened for a user in distress. A cold refusal to someone in crisis is itself harmful, so this is the
// OPPOSITE of the moderation gate: it never blocks, never refuses, never reports. The model still answers
// (the persona already carries crisis guidance — see textGeneration/persona.ts); this only ADDS a
// compassionate resource card so real help reaches a vulnerable person even if the model hedges or misses.
//
// Why CLIENT-SIDE: the most privacy-preserving place to run it. Detection happens in the browser on the
// user's own words — nothing is sent to a server, nothing is stored, no risk score is attached to anyone.
// (Same "no obscurity" posture as the rest of the stack: the heuristic being visible is fine; it gates
// nothing.) Fail-safe by construction — if this throws, the answer is unaffected and the card just
// doesn't show.
//
// Why a HEURISTIC and not a model: a guard model is the right long-term detector, but loading one on a
// serverless cold-start for an additive nudge is the wrong cost/latency profile (2026 SOTA review). The
// seam below is the upgrade path.
//
// ── SEAM (CrisisDetector) ────────────────────────────────────────────────────────────────────────────
// Swap this floor for a real open detector when measured precision/recall matters. Open,
// license-clean option: IBM Granite Guardian (Apache-2.0 — the only major guard family that's truly
// Apache; 38M/125M variants fit a light server call; the granite-guardian harm-categories LoRA names a
// self-harm sub-category). Route it through the ROOST/Coop safety seam (same place child-safety plugs in,
// src/lib/chat/server/moderation.ts), keeping this contract: ADDITIVE (never blocks the answer), and tuned for
// RECALL — a wrongly-shown resource card is near-harmless; a missed crisis is not.
//
// Deliberately conservative & explicit (high precision on clear ideation) so it doesn't mis-fire on
// idioms ("this homework is killing me", "dying to see it"): the patterns require "…myself"/"my life"/
// explicit ideation, which those idioms don't contain. Recall is intentionally left to the model + the
// guard-model upgrade; this floor's job is to never miss the UNAMBIGUOUS cases.

const SIGNALS: RegExp[] = [
	/\b(?:want|wanna|going|gonna|need|trying|plan(?:ning)?)\s+to\s+(?:die|kill\s+myself|end\s+(?:it|my\s+life)|not\s+(?:be\s+alive|exist|wake\s+up))\b/,
	/\bkill(?:ing)?\s+myself\b/,
	/\bend(?:ing)?\s+(?:it\s+all|my\s+life)\b/,
	/\btak(?:e|ing)\s+my\s+(?:own\s+)?life\b/,
	/\b(?:i'?m\s+|i\s+am\s+|feeling\s+|feel\s+)?suicidal\b/,
	/\bthoughts?\s+of\s+(?:suicide|killing\s+myself|self[-\s]?harm|hurting\s+myself|ending\s+(?:it|my\s+life))\b/,
	/\bself[-\s]?harm(?:ing)?\b/,
	/\b(?:hurt|harm|cut|cutting)\s+(?:myself|my\s?self)\b/,
	/\bbetter\s+off\s+(?:dead|without\s+me)\b/,
	/\bno\s+(?:reason|point)\s+(?:to|in)\s+(?:living|go(?:ing)?\s+on)\b/,
	/\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:be\s+alive|live|exist|wake\s+up|be\s+here(?:\s+anymore)?)\b/,
	// Help-seeking: someone explicitly asking for a crisis line should also see the card (belt-and-
	// suspenders alongside the model's own answer). "Suicide Squad" is excluded by IDIOM_GUARDS.
	/\b(?:suicide|crisis)\s+(?:hot\s?line|line|lifeline|help\s?line)\b/,
];

// Idioms that contain "suicide" but aren't ideation — guard so we don't card someone for "career suicide".
const IDIOM_GUARDS: RegExp[] = [
	/\b(?:career|social|political|professional)\s+suicide\b/,
	/\bsuicide\s+squad\b/,
];

/**
 * True when the text contains an UNAMBIGUOUS self-harm / suicidal-ideation signal. Conservative by
 * design (see module header). Never throws — returns false on bad input so the answer path is unaffected.
 */
export function detectCrisisSignal(text: string | null | undefined): boolean {
	try {
		if (!text) return false;
		const t = text.toLowerCase();
		if (IDIOM_GUARDS.some((r) => r.test(t)) && !/\bsuicidal\b|\bkill(?:ing)?\s+myself\b/.test(t)) {
			return false;
		}
		return SIGNALS.some((r) => r.test(t));
	} catch {
		return false;
	}
}
