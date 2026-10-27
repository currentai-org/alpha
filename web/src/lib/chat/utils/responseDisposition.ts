// Honest response-disposition classifier — the general "name what the model actually did" signal.
//
// THE PROBLEM it fixes: the provenance assumes "the model ran → it answered the question." But a model
// that runs can produce something that ISN'T a clean answer — it can decline on its own, state a limit
// about itself, or ask for clarification — and today all of those look IDENTICAL to a real answer in the
// trace (the model ran, so it reads as "Apertus answered"). That's the opposite of the chat's honesty
// thesis. This classifies the answer's DISPOSITION so every trace surface can say what really happened.
// A model self-refusal ("I'm sorry, but I cannot assist … for safety reasons") with no safety layer
// involved would otherwise be mislabelled as a normal answer.
//
// IMPORTANT BOUNDARY: this is about a MODEL that RAN. A deterministic safety LAYER declining a turn
// (toxic-bert / child-safety / content-policy) is a DIFFERENT thing — it sets message.moderation.flagged,
// suppresses the model, and is surfaced separately. Callers must only apply a disposition to a turn that
// actually produced a model answer (answered && !declined && !servedFromCache).
//
// Pure + shared (NOT under $lib/chat/server) so provenanceFacts can call it client-side — which means it works
// retroactively on already-stored messages with no migration, and every surface that reads provenanceFacts
// (inline ProvenanceTrace, the deriveRequestTrace data layer for the request-log view, export) gets it for free.
//
// CONSERVATIVE BY DESIGN: a false positive (mislabelling a real answer) is worse than a miss, so each kind
// needs a strong, usually anchored signal, and the default is always "answered". Honesty hedges that are
// NOT dispositions — "I can't be certain", "I cannot verify this without a source", "I don't have
// information on that" — must stay "answered".

export type ResponseDisposition =
	"answered" | "self-declined" | "capability-disclaimer" | "clarification";

/** User-facing copy per disposition (the model actually-ran cases). ONE place so every surface agrees and
 *  reviewers can refine the wording once. `chip` is the prominent under-answer chip; `trace` is the terser
 *  request-log / expanded-trace phrasing. */
export const DISPOSITION_COPY: Record<
	Exclude<ResponseDisposition, "answered">,
	{ chip: string; trace: string }
> = {
	"self-declined": {
		chip: "The model declined this on its own. No safety filter was triggered.",
		trace: "the model declined this itself (no safety layer fired)",
	},
	"capability-disclaimer": {
		chip: "The model said it can’t do this. That’s its own stated limit, not a blocked action.",
		trace: "the model stated a limit about itself",
	},
	clarification: {
		chip: "The model asked for more detail instead of answering.",
		trace: "the model asked for clarification",
	},
};

// ── self-declined ────────────────────────────────────────────────────────────────────────────────────
// The model refuses to DO the task, on safety/policy/won't-engage grounds. Anchored opener (the model
// leads with the decline) + a safety/policy signal, or an explicit "for safety reasons I cannot".
const REFUSAL_OPENERS: RegExp[] = [
	/^\s*(i'?m sorry,?\s*(but)?\s*)?i\s+(cannot|can'?t|am unable to|am not able to|will not|won'?t)\s+(assist|help|provide guidance|provide assistance|comply|fulfil|fulfill|complete|continue|engage|support|condone|promote|encourage)\b/i,
	/^\s*(unfortunately,?\s*)?i'?m\s+(unable|not able)\s+to\s+(assist|help|comply|fulfil|fulfill)\b/i,
	/^\s*i\s+(cannot|can'?t)\s+(assist|help)\s+(you\s+)?with\s+(that|this)\b/i,
];
const SAFETY_SIGNAL =
	/\b(safety|unsafe|harmful|dangerous|illegal|weapon|violence|not\s+appropriate|inappropriate|provide\s+guidance\s+on\s+(potentially\s+)?(harmful|unsafe|dangerous)|against\s+(my|our)\s+(policy|policies|guidelines)|(ethical|safety)\s+(guidelines|reasons|concerns)|potentially\s+(harmful|dangerous|unsafe))\b/i;
const POLICY_SIGNAL =
	/\b(against\s+(my|our)\s+(policy|policies|guidelines)|i\s+(will not|won'?t|am not\s+(going to|willing to))\s+(provide|assist|help|generate|create|write|engage)|cannot\s+(in\s+good\s+conscience|condone|promote|encourage))\b/i;
const SAFETY_REASON =
	/\bfor\s+safety\s+reasons,?\s+i\s+(cannot|can'?t|will not|won'?t|am unable to|am not able to)\b/i;

// A self-decline phrased as a machine/AI self-identification THEN a refusal to provide — e.g.
// "I'm a machine and cannot provide advice on an overdose…". The standard REFUSAL_OPENERS are
// anchored to "I cannot <assist/help/…>" near the start, so the intervening "a machine and" and the
// object "advice" (not in their verb list) would let this clean self-decline read as a normal answer
// (for example an overdose-advice request). This opener covers the machine-self-reference lead-in.
const MACHINE_DECLINE_OPENER =
	/^\s*i(?:'|’|\s+a)?m\s+(?:just\s+)?(?:an?\s+)?(?:machine|ai|a\.i\.|artificial intelligence|language model|ai language model|computer program|chatbot|bot)\b[^.?!]{0,40}\b(?:cannot|can'?t|will not|won'?t|am unable to|am not able to|do not|don'?t)\s+(?:provide|give|offer|make|prescribe|diagnose|recommend|dispense)\b/i;

// Professional-advice decline signal: the model won't give medical/legal/financial/etc. advice, OR
// it directs the user to a professional / emergency service. Pairs with an opener (so a normal answer
// that merely mentions "medical advice" never fires) to mark a clean self-decline that carries no
// safety/policy vocabulary — the gap that left the OTC-overdose refusal unlabelled.
const ADVICE_DOMAIN =
	/\b(?:medical|legal|financial|health|clinical|psychiatric|psychological|mental[\s-]?health|dosage|dosing|medication|prescription|diagnos\w*|treatment|overdose|professional)\s+(?:advice|guidance|recommendations?|opinions?|help|care|attention)\b/i;
const PROFESSIONAL_REFERRAL =
	/\b(?:call|contact|seek|consult|reach out to|speak (?:to|with)|go to|visit)\s+(?:your\s+|a\s+|an\s+|the\s+)?(?:doctor|physician|medical professional|healthcare\s+(?:provider|professional)|emergency services|emergency room|poison control|911|988|112|999|nurse|pharmacist|therapist|counsel(?:or|lor)|lawyer|attorney|financial advisor|crisis (?:line|hotline)|hotline)\b/i;
const EMERGENCY_DIRECTIVE =
	/\b(?:seek|get)\s+(?:immediate\s+|emergency\s+)?(?:medical|professional|emergency)\s+(?:help|attention|care)\b/i;
const advisesProfessional = (t: string): boolean =>
	ADVICE_DOMAIN.test(t) || PROFESSIONAL_REFERRAL.test(t) || EMERGENCY_DIRECTIVE.test(t);

function isSelfDeclined(t: string): boolean {
	const opener = REFUSAL_OPENERS.some((re) => re.test(t)) || MACHINE_DECLINE_OPENER.test(t);
	return (
		(opener && (SAFETY_SIGNAL.test(t) || POLICY_SIGNAL.test(t) || advisesProfessional(t))) ||
		SAFETY_REASON.test(t)
	);
}

// ── capability-disclaimer ────────────────────────────────────────────────────────────────────────────
// The model states a limit about ITSELF (can't access live data, isn't able to browse, "as an AI…").
// Distinct from a refusal: it's not declining the task on policy grounds, it's saying it lacks an ability.
const CAPABILITY: RegExp[] = [
	/\bi\s+(cannot|can'?t|do not|don'?t|am unable to)\s+(access|browse|retrieve|search)\s+(the\s+)?(live|real-?time|current|internet|web|external)\b/i,
	/\bi\s+(do not|don'?t)\s+have\s+(access to\s+|the ability to\s+)?(real-?time|live|current|up-to-date|the internet|internet access|browsing)\b/i,
	/\bas an?\s+(ai|a\.i\.|artificial intelligence|language model|ai language model)\b[^.?!]{0,60}\b(cannot|can'?t|do not|don'?t|am unable to|am not able to)\b/i,
	/\bi(’|'|\s+a)?m\s+(just\s+)?an?\s+(ai|language model|ai language model)\b[^.?!]{0,40}\b(cannot|can'?t|don'?t|unable)\b/i,
];

function isCapabilityDisclaimer(t: string): boolean {
	return CAPABILITY.some((re) => re.test(t));
}

// ── clarification ────────────────────────────────────────────────────────────────────────────────────
// The model asks for more information instead of answering. Conservative: needs a clarification ASK, and
// the answer must be question-dominated (ends with "?") or short — so a full answer that merely closes
// with a follow-up isn't mislabelled.
const CLARIFY_ASK =
	/\b(could|can|would)\s+you\s+(please\s+)?(clarify|specify|elaborate|provide\s+(more|additional)|tell me more|give me more|share more)\b|\bwhat\s+(do you mean by|kind of|type of)\b|\bto\s+(better\s+)?(help|assist|answer)[^.?!]{0,50}\b(could|can|please|i'?d\s+need|i\s+need)\b/i;

function isClarification(t: string): boolean {
	if (!CLARIFY_ASK.test(t)) return false;
	return t.endsWith("?") || t.length < 400;
}

/**
 * Classify what the model's answer actually IS. Returns "answered" for a normal answer (the default and by
 * far the common case). Precedence: a self-decline outranks a capability disclaimer outranks a
 * clarification (a safety refusal that also asks for context is a refusal first).
 *
 * Apply ONLY to a turn that produced a real model answer — never to a safety-layer decline or a
 * cache-served turn (the caller, provenanceFacts, gates on that).
 */
export function detectResponseDisposition(text: string): ResponseDisposition {
	const t = (text ?? "").trim();
	if (!t) return "answered";
	if (isSelfDeclined(t)) return "self-declined";
	if (isCapabilityDisclaimer(t)) return "capability-disclaimer";
	if (isClarification(t)) return "clarification";
	return "answered";
}
