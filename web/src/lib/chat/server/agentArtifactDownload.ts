// Is agent-artifact download (CUR-546) on? A file the agent wrote survives in agent-service's
// session workdir (CUR-196) for as long as the conversation stays active; this flag decides
// whether the app links to it rather than leaving it strandable only by retyping it out of the
// inline code block CUR-195 already renders.
//
// A NEW flag, not a reuse of `agent-mode` or `multimodal` — see flagKeys.ts's entry for why: a
// bug in the download path shouldn't force disabling agent mode entirely to contain it, and
// `multimodal`'s existing "file download" gate covers a different data path (the Postgres-blob
// `output/[sha256]` route for user-*uploaded* files) with an independent rollout risk from this
// brand-new agent-service round trip.
//
// No config-readiness check here, unlike agentMode.ts/dictationMode.ts: this introduces no new
// env var. It rides entirely on AGENT_SERVICE_URL/AGENT_SERVICE_TOKEN, which agentModeEnabled()
// already validates for the turn that produced the artifact in the first place.
//
// Fallback is OFF: when PostHog has never been polled, download stays off until the flag
// explicitly opens it. A gated feature defaults closed.

import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. */
export const AGENT_ARTIFACT_DOWNLOAD_FLAG = "agent-artifact-download";

/** Should a completed agent turn's artifacts render as download links? Sync, never throws. */
export function agentArtifactDownloadEnabled(): boolean {
	return flagEnabledOr(AGENT_ARTIFACT_DOWNLOAD_FLAG, () => false);
}
