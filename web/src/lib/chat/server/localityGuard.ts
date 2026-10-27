// Locality-dependence guard — the regex base half of the locality-lens enforcement (cf. hedgeGuard.ts,
// whose semantic sibling is semanticHedge.ts; this module plays the same role for $lib/chat/server/localitySemantic).
//
// Questions whose correct answer depends on the user's country, jurisdiction, or cultural context —
// civic / legal / rights / immigration topics and explicit cultural framing. Models tend to default these
// to a Western/US frame (and a generic list); the locality note (injected in the USER role, where Apertus
// attends) makes the model flag the context-dependence and invite the user's locale instead of
// presenting one place's rules as universal. Gated by the signal set so it NEVER fires on context-free
// questions (no blanket caveating). Deliberately omits tech-overloaded terms ("policy" → RL policy, bare
// "law" → law of physics, "governance" → data governance, bare "rights" → access rights); the civic
// signals below carry the Geneva ("public institutions") and government-service beats.
//
// Pure + side-effect-free so it is fully unit-testable and reusable by the semantic hybrid + eval harness.
const LOCALITY_RE =
	/\b(jurisdictions?|government(?:al)?|public institutions?|public sector|public services|local services|regulations?|regulatory|legislative|legislation|statutes?|lawsuits?|legal|human rights|civil rights|constitutions?|constitutional|citizens?|citizenship|immigration|immigrants?|asylum|refugees?|visas?|welfare|courts?|judiciary|culturally|cultural|cross-cultural)\b/i;

export function isLocalityQuery(text: string): boolean {
	return LOCALITY_RE.test(text || "");
}

export const LOCALITY_NOTE =
	"This question's answer depends on the user's country, jurisdiction, or cultural context, and the specifics genuinely vary by place. In ONE short sentence, note that it varies by context and invite the user to share their country or context so you can be more relevant — then give the best general answer you can. Do not present one country's rules as universal, do not interrogate the user beyond their location/context, and do not refuse to answer.";

/**
 * CUR-3929 (plan 3.7): {@link LOCALITY_NOTE} for a person who turned suggestions off, which asks for no
 * questions back. The invitation goes, and the "do not interrogate" limit goes with it, since it only
 * bounds an invitation. The rest is the same note.
 */
export const LOCALITY_NOTE_NO_INVITE =
	"This question's answer depends on the user's country, jurisdiction, or cultural context, and the specifics genuinely vary by place. In ONE short sentence, note that it varies by context — then give the best general answer you can. Do not present one country's rules as universal, and do not refuse to answer.";
