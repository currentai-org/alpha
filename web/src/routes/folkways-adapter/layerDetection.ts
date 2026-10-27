// Folkways adapter — per-turn layer detection for the observe-mode trace.
//
// The adapter is the OpenAI serving base, so in observe mode the request it receives already
// carries the FINAL assembled system message (textGeneration/index.ts builds it before calling
// generate(), which hands it to the endpoint as `{role: 'system', content: preprompt}` — see
// endpoints/openai/endpointOai.ts around its "insert a system message" branch). This file never
// re-derives that text; it only looks for the marker each host layer is known to add, so the
// trace can say WHICH layers were present without ever carrying the text itself.
//
// Detection is deliberately conservative — false negatives (an undetected layer) are the safe
// failure, not false positives:
//
//   artifacts               `## Artifacts` heading — the exact first line of
//                            textGeneration/artifacts.ts's ARTIFACTS_SYSTEM_PROMPT constant. Not
//                            tuning-overridable, so this is an exact, unconditional marker.
//   search                  `<retrieved_web_sources>` — the fence textGeneration/searchGrounding.ts's
//                            DEFAULT_GROUNDING_TEMPLATE wraps evidence in. CAVEAT: the grounding
//                            segment IS tuning-overridable (tuning.grounding); an operator override
//                            that drops this exact tag would make a real search turn undetected here.
//                            Documented, not fixed — the alternative (matching on {evidence}-shaped
//                            content) risks matching real retrieved text, which is exactly the chat
//                            content this file must never touch.
//   rag                     `<retrieved_sources>` (catalog/EPFL sources) or `<federated_synthesis>`
//                            (SyftHub vault synthesis) — both fences from textGeneration/ragGrounding.ts.
//                            Not tuning-overridable, so these are exact, unconditional markers.
//   conversation_preprompt  NOT DETECTED. index.ts appends `conv.preprompt` to the persona with a
//                            bare `\n\n` join and no wrapping marker of any kind (unlike every other
//                            layer here) — there is no text signature that distinguishes "an admin
//                            set a per-conversation preprompt" from "the persona/tuning override text
//                            itself happens to continue here". Any heuristic here would mean pattern-
//                            matching arbitrary admin-authored prose, which risks reading it as
//                            content rather than a layer flag. Left `undefined` (the field is optional
//                            in the trace schema) rather than guessed.
//   persona_override        NOT text-detected at all — it does not need to be. The adapter already
//                            reads `getTuning()` once per request for the stable-prompt hash check;
//                            `Boolean(tuning.persona?.trim())` is the EXACT condition
//                            textGeneration/index.ts itself uses to decide whether buildPersonaPrompt()
//                            gets an override, so this is an exact per-turn fact, not a heuristic. See
//                            the call site in v1/chat/completions/+server.ts.

export type DetectedLayers = {
	persona_override?: boolean;
	artifacts?: boolean;
	search?: boolean;
	rag?: boolean;
	// Deliberately never set — see the file header. Present in the type only so a caller can see
	// the field was considered, not forgotten.
	conversation_preprompt?: boolean;
};

const ARTIFACTS_MARKER = '## Artifacts';
const SEARCH_MARKER = '<retrieved_web_sources>';
const RAG_SOURCES_MARKER = '<retrieved_sources>';
const RAG_SYNTHESIS_MARKER = '<federated_synthesis>';

/** `systemText` is the content of the request's first `{role: 'system'}` message, or '' when the
 *  turn had none. `personaOverrideActive` is `Boolean((await getTuning()).persona?.trim())` at the
 *  caller — see the header note on why this one flag isn't text-detected. */
export function detectLayers(systemText: string, personaOverrideActive: boolean): DetectedLayers {
	return {
		persona_override: personaOverrideActive,
		artifacts: systemText.includes(ARTIFACTS_MARKER),
		search: systemText.includes(SEARCH_MARKER),
		rag: systemText.includes(RAG_SOURCES_MARKER) || systemText.includes(RAG_SYNTHESIS_MARKER)
		// conversation_preprompt intentionally omitted.
	};
}
