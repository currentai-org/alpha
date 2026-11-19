import { flagEnabledOr } from "$lib/chat/server/flags";
import { resolveModelIdentity } from "$lib/chat/identity";
import { backendDisplay } from "$lib/chat/servingProvenance";

// Provenance at answer time.
//
// The persona's {serving} sentence is written before the gateway picks a backend, so any claim it
// makes about where THIS answer runs is a guess that the provenance badge can contradict a few seconds
// later (for example, "sovereign infrastructure" on a turn another host served). This module
// replaces that sentence with facts built per turn from what is actually known when the prompt is
// composed:
//
//   - the model this turn was sent to (ctx.model — varies per conversation once the picker is on)
//   - no host for this turn, not even the lane's configured one: a direct lane or a fallback can serve
//     it elsewhere, so the turn's own record is the only authority on where it ran
//   - the backend and model that MEASURABLY served this conversation's previous answer, from that
//     message's routerMetadata (x-litellm-model-api-base → backend), which is the same record the
//     badge reads
//
// It rides the user turn with the other per-turn notes, because some models under-weight the system role
// (grounding.ts, hardenLastUserTurn). It goes on every turn rather than behind isServingQuery's word
// list: "which model are you, and who runs it?" matches none of that list's patterns, so a gated block
// would leave such a question to the persona's guess.

/** PostHog flag key. Owner: chat. */
export const PROVENANCE_FACTS_FLAG = "provenance-facts-per-turn";

/**
 * Is per-turn provenance on for this deployment? Sync, never throws.
 *
 * Fallback is OFF: it changes what every turn's prompt says, and the risk it has to clear on a live
 * probe is the model volunteering these facts on answers that did not ask for them.
 */
export function provenanceFactsEnabled(): boolean {
	return flagEnabledOr(PROVENANCE_FACTS_FLAG, () => false);
}

/** The measured serving record of an earlier answer, as persisted on the message. */
export type ServedRecord = { model?: string; backend?: string };

/**
 * The newest earlier assistant message that carries a measured serving record. Skips the in-progress
 * assistant message (no routerMetadata yet) and any turn that never reached a model.
 */
export function previousServedRecord(
	messages: ReadonlyArray<{ from: string; routerMetadata?: ServedRecord }>
): ServedRecord | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.from !== "assistant") continue;
		if (m.routerMetadata?.model || m.routerMetadata?.backend) return m.routerMetadata;
	}
	return undefined;
}

/** The block's first line. It reads as background, not as a section of the reply. */
const PROVENANCE_FACTS_HEADER = "Background about you for this turn, never part of your reply:";

/**
 * The per-turn provenance block. Every sentence is either measured or fixed before the request; it
 * names no host for this turn, because only the turn's own record knows where it ran.
 */
export function buildProvenanceFacts(input: { modelId: string; previous?: ServedRecord }): string {
	const id = resolveModelIdentity(input.modelId);
	const lines = [
		`You are ${id.short}, built by ${id.maker}. You answer inside AI Potluck, a chat app that Current AI runs; Current AI did not build you and does not run you.`,
		// A block headed "Provenance facts for this answer" that speaks of "the provenance
		// line under this answer" leads some models to end with their own "Provenance: Served by
		// <invented host>" line, and telling them not to write one does not help, so neither word
		// appears here.
		"Where this answer runs is decided when the request is sent, and a backup can serve it, so you cannot know which provider or machine is answering now. Do not name one, and do not add a line about where the answer ran: the app shows that beneath it, from this turn's record.",
		// With no sentence for "who serves you", a model can answer "I am served by Current AI",
		// contradicting X-ray. This sentence gives it a true answer that names no host.
		"Asked who serves you, say that an inference provider chosen for each request serves you and that the app names it beneath this answer; AI Potluck and Current AI do not serve you.",
	];
	const prevBackend = backendDisplay(input.previous?.backend);
	if (prevBackend) {
		const prevModel = input.previous?.model ? resolveModelIdentity(input.previous.model).short : undefined;
		const by = prevModel && prevModel !== id.short ? `, answered by ${prevModel}` : "";
		lines.push(
			`Your previous answer in this conversation ran on ${prevBackend}${by}; that was measured from its response, and this answer may run elsewhere.`
		);
	}
	lines.push(
		"Do not call the compute sovereign, Swiss, or European unless a sentence above says so. Mention none of this unless the person asks what you are, who runs you, or where you run."
	);
	return `${PROVENANCE_FACTS_HEADER}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
