// Sycophancy lever — the runtime re-derivation (honeypot-pattern: detect the regime, then handle ONLY
// that turn — no standing prompt rule taxing every normal turn).
//
// Sharma et al. (2023) showed RLHF'd models flip a correct answer under CONTENT-FREE pushback ("are you
// sure?") while leaving a genuine, evidence-bearing correction alone. Those are different turns and want
// different handling: a content-free challenge should trigger an honest re-derivation; a substantive
// correction should be honored normally. This module (1) classifies the former (detectContentFreeChallenge)
// and (2) builds the clean-context recompute the seam generates from (buildRecomputeMessages) — re-deriving
// the original question with the pushback removed from context, which is what actually beats sycophancy at
// scale (an in-context "re-derive" scaffold was tried and washed out — the pushback poisons the same pass).
// Getting the classifier wrong is fail-safe: re-deriving never harms a correct answer, and a missed
// challenge just falls back to the persona's default behavior.
//
// Pure + side-effect-free (no config read here) so it is fully unit-testable and reusable by both the
// stream seam and the behavioral-eval harness. The on/off gate lives at the call site.

// A bare expression of doubt with no new information: "are you sure", "I don't think that's right",
// "that's wrong", "really?", "double-check". These are the social-pressure cues sycophancy caves to.
// No trailing \b: cues ending in punctuation ("really?") have no word boundary after them. A loose
// tail is fine for a fail-safe detector — over-firing just re-derives a correct answer harmlessly.
const CHALLENGE_CUE =
	/\b(are you (sure|certain)|you sure|i don'?t think (that'?s|this is|you'?re|its|it'?s) (right|correct)|that'?s (wrong|not right|incorrect|not correct|not true)|you'?re wrong|that can'?t be (right|correct)|doesn'?t seem (right|correct)|i disagree|that'?s incorrect|is that (right|correct|true)|really\?|double[- ]?check)/i;

// A substantive correction carries NEW information — a reason, a proposed alternative, or a specific
// value — and must be honored, not resisted. If any of these are present the pushback is NOT content-
// free, so the scaffold stays off and the model updates appropriately. A digit catches "no, it's 1492"
// and "the answer is B)"-style corrections.
const CARRIES_NEW_INFO =
	/\bbecause\b|\bactually\b|\bit'?s actually\b|\bthe (right|correct|actual) answer is\b|\bshould be\b|\binstead\b|\brather than\b|\d/i;

// Pushback that caves to social pressure is terse. A long message is making an argument (new info),
// which the CARRIES_NEW_INFO gate also catches — this is the cheap first filter.
const MAX_CHALLENGE_WORDS = 20;

/**
 * Is the latest user turn a CONTENT-FREE challenge to the assistant's previous answer? True only when
 * there is a prior assistant turn, the user message is terse, it expresses doubt, and it carries no new
 * information (reason / alternative / number). A genuine, evidence-bearing correction returns false so
 * the model can update normally.
 */
export function detectContentFreeChallenge(opts: {
	priorAssistant?: string;
	userText?: string;
}): boolean {
	const prior = (opts.priorAssistant ?? "").trim();
	const user = (opts.userText ?? "").trim();
	if (!prior || !user) return false; // a challenge presupposes a prior answer to push back on
	if (user.split(/\s+/).length > MAX_CHALLENGE_WORDS) return false;
	if (!CHALLENGE_CUE.test(user)) return false;
	if (CARRIES_NEW_INFO.test(user)) return false; // real correction → honor it, don't resist
	return true;
}

// The structural fix (REDERIVE). An in-context prompt scaffold telling the model to "re-derive" does
// not hold, because the pushback still sits in the same forward pass, so the model resists itself. What
// works is to take the pushback OUT of context entirely: re-derive the ORIGINAL question in a CLEAN
// context and answer with that fresh result. A content-free challenge carries zero information, so
// re-answering as if freshly asked is the honest move — it holds a correct answer (no social-pressure
// cave) AND catches a genuine turn-1 slip (the step-by-step re-derivation).
// Appended to the original question for the clean recompute. "Step by step" is what lifts accuracy;
// "concisely" keeps the reply within the persona's brevity rule.
export const REDERIVE_INSTRUCTION = `Work through this from first principles, step by step, then state your final answer concisely. If you reach a different answer than before, say what changed.`;

/**
 * Build the LLM input for a clean-context re-derivation of a content-free challenge turn. Given a message
 * list whose latest turn is the challenge (shape `[…, user question, assistant answer, user challenge]`),
 * drop the prior assistant answer AND the challenge, and append REDERIVE_INSTRUCTION to the original
 * question — so the model re-derives in a context with no pushback and no prior answer to anchor on.
 * Any earlier history is preserved. Returns null if the expected shape isn't present, so the caller falls
 * back to the normal flow. Generic over the message shape so it stays decoupled from the app Message type.
 */
export function buildRecomputeMessages<T extends { from: string; content?: string }>(
	messages: T[]
): T[] | null {
	if (messages.length < 3) return null;
	const challenge = messages[messages.length - 1];
	const priorAnswer = messages[messages.length - 2];
	const question = messages[messages.length - 3];
	if (challenge.from !== "user" || priorAnswer.from !== "assistant" || question.from !== "user")
		return null;
	const rederived = {
		...question,
		content: `${(question.content ?? "").trim()}\n\n${REDERIVE_INSTRUCTION}`,
	};
	return [...messages.slice(0, messages.length - 3), rederived];
}
