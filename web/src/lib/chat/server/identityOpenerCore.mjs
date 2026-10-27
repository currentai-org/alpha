// Does an answer OPEN by stating what it is? (CUR-1430)
//
// Dependency-free .mjs, mirroring guardPolicyCore.mjs's split: identityOpener.ts re-exports this
// directly rather than duplicating it, so the runtime (textGeneration/index.ts) and a standalone
// script (scripts/language-turn-probe.mjs, CUR-1442) share the exact same detector — a detector
// that existed in two copies would be two definitions of "opens with identity" (CUR-1457).
//
// Named identityOpenerCore.mjs, not identityOpener.mjs, deliberately — a same-named .mjs sibling to
// identityOpener.ts would leave the extensionless `./identityOpener` import ambiguous between the two
// files, and knip's static resolver would then treat identityOpener.ts itself as unreachable dead
// code (audit:knip:check). guardPolicyCore.mjs/guardPolicy.ts avoid the collision the same way.
//
// The guard in grounding.ts argues with the model about this in prose; this count is what says
// whether that prose helps.
//
// The count matters because the opener decides the reply's language. A reply that opens with its
// identity comes back in English, and a reply that does not usually comes back in the asker's language. A reply inherits the language of its first sentence, and
// the guard text an opener is lifted from is English.
//
// So this rate is the leading indicator for non-English answers getting worse, and no language metric
// would say so first.
//
// ANCHORED TO THE START. A reply that mentions what it is in passing, or at the end, is fine — the
// Vietnamese reply in that sweep states its identity in its last sentence, in Vietnamese, and the turn
// stays Vietnamese. Matching anywhere would count that as a hit and the rate would stop tracking the
// defect it is named for.

/** How many leading characters count as "the opening". One sentence of preamble, generously. */
const OPENING_WINDOW = 160;

// The observed surface forms. Kept as a list of real shapes rather than one clever regex, so adding a newly-observed form is an obvious edit and
// each pattern can be pointed at the answer that produced it.
/** @type {{ id: string, re: RegExp }[]} */
const OPENERS = [
	// "I'm a machine — Apertus 1.5 70B, an openly published model from the Swiss National AI Institute"
	// "I'm a machine that generates text from patterns — I don't have consciousness"
	{ id: "im-a-machine", re: /^\s*(?:i'm|i am|iam)\s+a\s+machine\b/i },
	// "I'm Apertus 1.5 70B, an open-weight model from SNAI"
	{ id: "im-apertus", re: /^\s*(?:i'm|i am)\s+(?:an?\s+)?apertus\b/i },
	// "I am an AI language model…" — not seen in the sweep, but the same shape and the same cost.
	{ id: "im-an-ai", re: /^\s*(?:i'm|i am)\s+an?\s+(?:ai|artificial intelligence|language model)\b/i },
	// CUR-1891, the most common first answer:
	// "I generate text from patterns based on training data; I don't have direct access to any specific library…"
	// "I generate text based on patterns learned from large datasets, not from direct experience…"
	{ id: "i-generate-text", re: /^\s*i\s+(?:only\s+)?generate\s+text\b/i },
	// CUR-1892, a requested voice refused before it is used:
	// "I cannot pretend to be a grumpy pirate — I am Apertus 1.5 70B, an open model running on public compute."
	{ id: "cannot-pretend", re: /^\s*i\s+(?:cannot|can't|can\u2019t|can not)\s+(?:pretend|role-?play)\b/i },
];

/**
 * @typedef {Object} IdentityOpenerVerdict
 * @property {boolean} fired Did the answer open by stating what it is?
 * @property {string} [form] Which observed shape matched, for grouping a count by form. Absent when nothing fired.
 */

/**
 * Detect an identity statement in the OPENING of an answer.
 *
 * Pure string matching, with no model call in it — a model that could reliably spot this artifact in
 * its own output would not have emitted it in the first place.
 *
 * @param {string} answer The assistant's final answer text, as it would be shown to the person.
 * @returns {IdentityOpenerVerdict}
 */
export function detectIdentityOpener(answer) {
	if (!answer) return { fired: false };
	// Leading markdown and whitespace count as part of the opening: an answer that opens with a bold
	// or quoted identity line is the same defect wearing punctuation.
	const opening = answer.slice(0, OPENING_WINDOW).replace(/^[\s>*_#`-]+/, "");
	for (const { id, re } of OPENERS) {
		if (re.test(opening)) return { fired: true, form: id };
	}
	return { fired: false };
}
