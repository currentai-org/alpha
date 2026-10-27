import type { BackendModel } from "$lib/chat/server/models";
import type { AgentMode } from "$lib/chat/stores/agentMode";

export type GETModelsResponse = Array<{
	id: string;
	name: string;
	websiteUrl?: string;
	modelUrl?: string;
	datasetName?: string;
	datasetUrl?: string;
	displayName: string;
	description?: string;
	/** One measured weak spot for the picker to show, from modelWeakSpots.ts (CUR-970). */
	knownWeakSpot?: string;
	logoUrl?: string;
	providers?: Array<{ provider: string } & Record<string, unknown>>;
	promptExamples?: { title: string; prompt: string }[];
	parameters: BackendModel["parameters"];
	preprompt?: string;
	multimodal: boolean;
	multimodalAcceptedMimetypes?: string[];
	supportsTools: boolean;
	supportsReasoning: boolean;
	supportsArtifacts: boolean;
	unlisted: boolean;
	hasInferenceAPI: boolean;
	isRouter: boolean;
}>;

export type GETOldModelsResponse = Array<{
	id: string;
	name: string;
	displayName: string;
	transferTo?: string;
}>;

export interface FeatureFlags {
	enableAssistants: boolean;
	loginEnabled: boolean;
	// Whether sign-in is MANDATORY (config.AUTOMATIC_LOGIN === "true"), distinct from loginEnabled (is
	// sign-in merely configured/offered). handle.ts's two server-side force-login gates require BOTH —
	// CUR-246 added this split specifically so "configured" never silently implies "required" (accounts
	// are additive, not required). Client code that forces a login redirect (requireAuthUser) MUST check
	// both fields too, or it re-derives the exact pre-CUR-246 bug from only half the server's condition.
	automaticLogin: boolean;
	isAdmin: boolean;
	transcriptionEnabled: boolean;
	/** A CSAM scanner is configured, so uploads can be accepted and the attach control shows. (CUR-2382) */
	attachmentsEnabled: boolean;
	/** The composer also accepts PDF and DOCX, which the server reads to text. (CUR-987) */
	documentAttachmentsEnabled: boolean;
	/** The `multimodal` flag for this visitor's account; images are team-only on preview. (CUR-2725) */
	imageInputEnabled: boolean;
	// Per-user access (CUR-121, CUR-771): agentModeEnabledForUser(), not the deployment-wide
	// agentModeEnabled(). The composer toggle renders only when this is true, so the control never
	// shows for a user who'd just get denied at turn time.
	agentEnabled: boolean;
	// What the composer's AgentMode toggle should default to for THIS caller, the one time
	// nothing is in localStorage yet — "auto" for a cleared tester, "off" otherwise. Never overrides an
	// explicit past choice; see stores/agentMode.ts's seeding function. (CUR-770)
	agentModeDefault: AgentMode;
	// Read-aloud / TTS (readAloudGate.ts, CUR-225). Drives BOTH client surfaces — the in-message audio
	// player and the `hidden` class on the composer toggle — because the feature had two independent off
	// switches and flipping only the server one would have re-enabled synthesis with no way to reach it.
	readAloudEnabled: boolean;
	// May this caller export their own data (dataPortability.ts)? Drives the account page's
	// "Download your data" row. Same gate the endpoint reads, so the row cannot appear where the
	// request would 403. (CUR-1681)
	dataExportEnabled: boolean;
	// May this caller download the Thunderbolt file (dataPortability.ts)? Same gate the
	// api/v2/export/thunderbolt route reads, so the row cannot appear where the request would 404. (CUR-2407)
	thunderboltExportEnabled: boolean;
	/** Settings → Connections and the Account row's link to it, for a signed-in account with thunderbolt-sync on. (CUR-4312) */
	thunderboltSyncEnabled: boolean;
	/** The past-chat search switch in Personalization, for a signed-in account with past-chat-search on. (CUR-4576) */
	pastChatSearchEnabled: boolean;
	// May this caller see their own stored files (custodialStorageGate.ts)? Per-user, not
	// deployment-wide. Drives the settings nav "Storage" tab; the page 404s on the same gate. (CUR-1682)
	custodialStorageEnabled: boolean;
	// organizations/workspaces (workspacesGate.ts). Deployment-wide, not per-user — drives the
	// settings nav "Workspace" tab and page reachability. (CUR-913)
	workspacesEnabled: boolean;
	// Creating an additional workspace and inviting anyone into one — split from
	// workspacesEnabled above so the personal workspace view can be live without exposing this. Must
	// agree with the server-side gate on better-auth's own organization routes (routes/chat/api/auth/
	// [...all]) so a hidden screen and a reachable route never disagree about whether it's live. (CUR-957)
	workspaceOrgCreationEnabled: boolean;
	// per-user local (LAN/self-hosted) inference endpoints (localEndpointsGate.ts).
	// Deployment-wide, not per-user — drives the settings nav "Local Inference" tab and page
	// reachability; which endpoint(s) a signed-in user actually has is separate, per-user DB state. (CUR-1194)
	localInferenceEnabled: boolean;
	// The `mcp-servers` flag (mcp/servers.ts) for this request's account. Drives the settings
	// nav "Connectors" tab; the page 404s on the same read. (CUR-3984)
	mcpServersEnabled: boolean;
	// Auto model routing (autoRoutingGate.ts): deployment-wide. Off, the composer's model menu offers
	// no Auto and a new chat starts on the model chosen in settings.
	autoRoutingEnabled: boolean;
	// Auto picks again inside a turn its first choice did not answer (autoRepickGate.ts). (CUR-4384)
	autoRepickEnabled: boolean;
	/** An agent run outlives the chat request and the page follows it (agentRunHandoffGate.ts). (CUR-4410) */
	agentRunHandoffEnabled: boolean;
	// Each listed model's wait for a first word before Auto asks another, in ms; empty while off. (CUR-4384)
	autoRepickWaitMs: Record<string, number>;
	// Auto's hosted draft read (clefRoutingGate.ts): on, the composer also sends the draft to Clef after
	// a pause in typing. Off, Auto reads it in the browser only.
	clefRoutingEnabled: boolean;
	// Human evaluation's entry points (models page, Potluck Run), the same `human-eval` flag
	// that gates /chat/settings/evaluate and its API (humanEval/gate.ts). (CUR-1914)
	humanEvalEnabled: boolean;
	// The custodial Files view (/chat/storage) for THIS signed-in person — the same per-user
	// gate the route itself enforces (custodialStorageGate.ts), mirrored so the sidebar's "Files" entry
	// exists exactly when the page does. Always false for guests; fails closed like the gate. (CUR-1276)
	storageViewEnabled: boolean;
	// USAGE_LIMITS.messageLength, the character cap parseRequest refuses above with 400
	// (messageTooLongMessage, CUR-3695), or null when none is set. ChatWindow checks it before the send so an
	// over-long message never renders as sent and then disappears. (CUR-1921)
	messageLengthLimit: number | null;
}
