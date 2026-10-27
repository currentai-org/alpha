// Resolve the model a stored conversation should continue on.
//
// A conversation persists `doc.model` as the model id that was current when it was created, and the
// registry only ever contains what MODEL_ALLOWLIST names TODAY. Every allowlist change therefore
// strands the conversations created before it: those on `swiss-ai/Apertus-70B-Instruct-2509` were left
// behind by an earlier allowlist change, and CUR-243's collapse onto `swiss-ai/apertus-v1.5-70b` would
// strand those on `swiss-ai/apertus-70b-instruct` the same way.
//
// Answering that with `error(410, "Model not available anymore")` would disagree with the CLIENT:
// `findCurrentModel` (utils/models.ts) falls back to `models[0]`, so the sidebar lists the
// conversation, the page opens, the picker shows the default — and then sending 410s. The user sees
// a working conversation that rejects every message. The server therefore agrees with what the
// client renders.
//
// WIDENING ON PURPOSE, AND LOUDLY. Any unresolvable id continues on the default rather than only a
// curated retired-id list. An allowlist of old ids is the shape upstream ships (OLD_MODELS +
// `transferTo`, still `{}` in the manifest and `[]` in +layout.server.ts) and it rots exactly the way
// the stranded conversations above show: nobody edits it at the moment they change the allowlist,
// because nothing makes them. What must NOT be silent is the substitution itself — the caller logs it,
// and `routerMetadata` on each persisted message records the model that actually served that turn, so
// no answer is ever attributed to the model the conversation was started on.
//
// This deliberately does NOT protect model ids the user PICKED for this turn: `validModelIdSchema`
// still rejects an unknown id on the way in. Only a stored conversation's historical id is widened.

import type { ProcessedModel } from "$lib/chat/server/models";

export type ConversationModelResolution<M> = {
	model: M;
	/** The stored id, when it no longer resolves and `model` is the default standing in for it. */
	retiredId?: string;
};

/**
 * The model to serve this conversation's next turn.
 *
 * Returns the registered model when the stored id still resolves. When it does not, returns
 * `defaultModel` and reports the stored id as `retiredId` so the caller can log the substitution —
 * a caller that ignores `retiredId` turns this into a silent widening, which is the one way to use
 * it wrongly.
 */
export function resolveConversationModel<M extends Pick<ProcessedModel, "id">>(
	registry: readonly M[],
	defaultModel: M,
	storedId: string | undefined
): ConversationModelResolution<M> {
	const direct = storedId ? registry.find((m) => m.id === storedId) : undefined;
	if (direct) return { model: direct };
	return { model: defaultModel, retiredId: storedId || "(unset)" };
}
