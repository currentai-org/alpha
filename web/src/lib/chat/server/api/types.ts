// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
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
	/** One measured weak spot for the picker to show, from modelWeakSpots.ts. */
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
	// sign-in merely configured/offered). handle.ts's two server-side force-login gates require BOTH, so
	// "configured" never implies "required" (accounts are additive, not required). Client code that forces
	// a login redirect (requireAuthUser) MUST check both fields too, or it forces sign-in on a deployment
	// that only offers it.
	automaticLogin: boolean;
	isAdmin: boolean;
	transcriptionEnabled: boolean;
	/** A CSAM scanner is configured, so uploads can be accepted and the attach control shows. */
	attachmentsEnabled: boolean;
	/** The composer also accepts PDF and DOCX, which the server reads to text. */
	documentAttachmentsEnabled: boolean;
	/** The `multimodal` flag, evaluated for this visitor's account. */
	imageInputEnabled: boolean;
	// Per-user access: agentModeEnabledForUser(), not the deployment-wide
	// agentModeEnabled(). The composer toggle renders only when this is true, so the control never
	// shows for a user who'd just get denied at turn time.
	agentEnabled: boolean;
	// What the composer's AgentMode toggle should default to for THIS caller, the one time
	// nothing is in localStorage yet — "auto" for a cleared tester, "off" otherwise. Never overrides an
	// explicit past choice; see stores/agentMode.ts's seeding function.
	agentModeDefault: AgentMode;
	// Read-aloud / TTS (readAloudGate.ts). Drives BOTH client surfaces, the in-message audio player and
	// the `hidden` class on the composer toggle, so one switch turns the whole feature on or off together.
	readAloudEnabled: boolean;
	// May this caller download the Thunderbolt file (dataPortability.ts)? Same gate the
	// api/v2/export/thunderbolt route reads, so the row cannot appear where the request would 404.
	thunderboltExportEnabled: boolean;
	/** The past-chat search switch in Personalization, for a signed-in account with past-chat-search on. */
	pastChatSearchEnabled: boolean;
	/** The page may follow a dropped turn through the generation follow route (stream-follow flag). */
	streamFollowEnabled: boolean;
	/** Where the status links lead (statusPage.ts statusPageUrl()); null on a self-host with no STATUS_PAGE_URL, and then no link shows. */
	statusPageUrl: string | null;
	/** May this signed-in account share read-only chat links (share-links flag)? */
	shareLinksEnabled: boolean;
	/** May this caller tag chats? Signed in, since a tag is kept on the account. */
	chatTagsEnabled: boolean;
	/** May this visitor enroll or unlock a history key here (history-key-enrollment flag, and a
	 *  deployment with custodial storage)? Guests get only the silent device key. */
	historyKeyEnabled: boolean;
	// May this caller see their own stored files (custodialStorageGate.ts)? Per-user, not
	// deployment-wide. Drives the settings nav "Storage" tab; the page 404s on the same gate.
	custodialStorageEnabled: boolean;
	// Creating an additional workspace and inviting anyone into one, separate from the
	// personal workspace view every signed-in account has. Must
	// agree with the server-side gate on better-auth's own organization routes (routes/chat/api/auth/
	// [...all]) so a hidden screen and a reachable route never disagree about whether it's live.
	workspaceOrgCreationEnabled: boolean;
	// Per-user local (LAN/self-hosted) inference endpoints (localEndpointsGate.ts).
	// Deployment-wide, not per-user — drives the settings nav "Local Inference" tab and page
	// reachability; which endpoint(s) a signed-in user actually has is separate, per-user DB state.
	localInferenceEnabled: boolean;
	// The `mcp-servers` flag (mcp/servers.ts) for this request's account. Drives the settings
	// nav "Connectors" tab; the page 404s on the same read.
	mcpServersEnabled: boolean;
	// The `google-connector` flag (connectors/google.ts): Connect Google, which also opens the Connectors tab.
	googleConnectorEnabled: boolean;
	// Auto model routing (autoRoutingGate.ts): deployment-wide. Off, the composer's model menu offers
	// no Auto and a new chat starts on the model chosen in settings.
	autoRoutingEnabled: boolean;
	// A self-host's model for large tasks (AUTO_LARGE_TASK_MODEL), when Auto has no catalogued model to rank.
	autoLargeTaskModel?: string;
	// Auto picks again inside a turn its first choice did not answer (autoRepickGate.ts).
	autoRepickEnabled: boolean;
	// Each listed model's wait for a first word before Auto asks another, in ms; empty while off.
	autoRepickWaitMs: Record<string, number>;
	// Auto's hosted draft read (clefRoutingGate.ts): on, the composer also sends the draft to Clef after
	// a pause in typing. Off, Auto reads it in the browser only.
	clefRoutingEnabled: boolean;
	// Human evaluation's entry points (models page, Potluck Run), the same `human-eval` flag
	// that gates /chat/settings/evaluate and its API (humanEval/gate.ts).
	humanEvalEnabled: boolean;
	// The custodial Files view (/chat/storage) for THIS signed-in person — the same per-user
	// gate the route itself enforces (custodialStorageGate.ts), mirrored so the sidebar's "Files" entry
	// exists exactly when the page does. Always false for guests; fails closed like the gate.
	storageViewEnabled: boolean;
	// USAGE_LIMITS.messageLength, the character cap parseRequest refuses above with 400
	// (messageTooLongMessage), or null when none is set. ChatWindow checks it before the send so an
	// over-long message never renders as sent and then disappears.
	messageLengthLimit: number | null;
	// Days a signed-in conversation lives under conversation expiry (conversationExpiry.ts), or null while
	// the `conversation-expiry` flag is off for this deployment.
	conversationExpiryDays: number | null;
}
