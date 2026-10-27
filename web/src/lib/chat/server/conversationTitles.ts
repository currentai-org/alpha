import { flagEnabledOr } from "$lib/chat/server/flags";

// Should a conversation get a model-generated title, or keep the first five words of its opening
// message?
//
// ── Why this moved off an env string ────────────────────────────────────────────────────────────
// The gate was `config.LLM_SUMMARIZATION !== "true"` read inline at the call site. That is an honest
// boolean — unlike the presence-as-toggle shape elsewhere — but it lived in env, where it cannot be
// rolled out to a fraction of traffic and cannot be turned off without a redeploy. The repo's flag rules draw
// the line: the flag decides on/off, env carries what the feature needs in order to RUN. Here that
// second half is `TASK_MODEL`, which names the model doing the titling and stays exactly where it is.
//
// ── The cost that makes it worth a rollout rather than a flip ───────────────────────────────────
// Turning this on adds a second model call per conversation, on the first clean turn. That spend and
// its latency want measuring on the develop preview before prod ever sees it, which is the whole
// argument for a flag with a release condition instead of a string in Doppler.
//
// ── Cold start fails closed (CUR-891) ───────────────────────────────────────────────────────────
// A cold-start fallback that mirrored the env predicate LLM_SUMMARIZATION evaluated would only matter
// in the narrow cold-start window (a fresh process, or local dev with no PostHog key), because once
// PostHog has polled successfully even once, `flagEnabledOr` keeps serving that last-known value
// forever (flags.ts). For that window, failing closed is the safer default, matching every other flag
// in this registry that isn't a presence-check paired to real config.

/** PostHog flag key. Owner: chat. Remove once titling is either the permanent default or dropped. */
export const CONVERSATION_TITLES_FLAG = "conversation-titles";

/** Should this conversation get a generated title? Sync, never throws. */
export function conversationTitlesEnabled(): boolean {
	return flagEnabledOr(CONVERSATION_TITLES_FLAG, () => false);
}
