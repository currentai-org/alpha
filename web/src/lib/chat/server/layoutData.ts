import { csamScanConfigured } from "$lib/chat/server/storage/csamScan";
import type { env as publicEnv } from "$env/dynamic/public";
import { agentModeEnabledForUser } from "$lib/chat/server/agentMode";
import { seesDeveloperTools } from "$lib/chat/server/adminRoles";
import { loginEnabled, authCondition } from "$lib/chat/server/auth";
import { config } from "$lib/chat/server/config";
import { dictationEnabled } from "$lib/chat/server/dictationMode";
import { documentAttachmentsOffered } from "$lib/chat/server/documentAttachmentsGate";
import { readAloudEnabled } from "$lib/chat/server/readAloudGate";
import { knownWeakSpotFor } from "$lib/chat/server/modelWeakSpots";
import { workspacesEnabled, workspaceOrgCreationEnabled } from "$lib/chat/server/workspacesGate";
import { autoRoutingEnabled } from "$lib/chat/server/autoRoutingGate";
import { autoRepickEnabled, autoRepickGiveUpFor } from "$lib/chat/server/autoRepickGate";
import { agentRunHandoffEnabled } from "$lib/chat/server/agentRunHandoffGate";
import { clefRoutingEnabled } from "$lib/chat/server/clefRoutingGate";
import { humanEvalEnabled } from "$lib/chat/server/humanEval/gate";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { mcpServersEnabled } from "$lib/chat/server/mcp/servers";
import { usageLimits } from "$lib/chat/server/usageLimits";
import { dataExportEnabled, thunderboltExportEnabled, thunderboltSyncEnabled } from "$lib/chat/server/dataPortability";
import { pastChatSearchEnabled } from "$lib/chat/server/pastChatSearchGate";
import { custodialStorageViewEnabledForUser } from "$lib/chat/server/storage/custodialStorageGate";
import { collections } from "$lib/chat/server/database";
import { defaultModel, models } from "$lib/chat/server/models";
import type { AnswerLanguage, Emojis, Format, Length, Tone } from "$lib/chat/answerPreferences";
import { logger } from "$lib/chat/server/logger";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { resolveLocalModelsForUser, getEffectiveValidModelIdSchema } from "$lib/chat/server/localModels";
import { CONV_NUM_PER_PAGE } from "$lib/chat/constants/pagination";
import type { GETModelsResponse, FeatureFlags } from "$lib/chat/server/api/types";
import { publicModelsSchema } from "$lib/chat/server/api/publicModel";
import { modelTakesImagesNow, multimodalEnabled } from "$lib/chat/server/textOnly";
import type { ConvSidebar } from "$lib/chat/types/ConvSidebar";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { WorkspaceScope } from "$lib/chat/server/currentWorkspace";
import { formerWorkspaceFilter } from "$lib/chat/server/formerWorkspaces";
import { DEFAULT_SETTINGS } from "$lib/chat/types/Settings";
import { resolveStreamingMode } from "$lib/chat/utils/messageUpdates";
import { storageRegionLabel } from "$lib/chat/servingRoute";

export type LayoutPublicConfig = Record<`PUBLIC_${string}`, string>;
export type LayoutUser = {
	id: string;
	/** The one display-name field every auth path sets (User["name"] is required, unlike
	 *  `username`, which only Hugging Face's provider populates) — this is what "show me I'm signed in, (CUR-432)
	 *  and under which name" (CUR-434) actually reads. */
	name: string;
	username?: string;
	avatarUrl?: string;
	email?: string;
	isAdmin: boolean;
	isEarlyAccess: boolean;
} | null;

export type LayoutSettings = {
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	activeModel: string;
	streamingMode: "raw" | "smooth";
	directPaste: boolean;
	hapticsEnabled: boolean;
	hidePromptExamples: Record<string, boolean>;
	customPrompts: Record<string, string>;
	customPromptsEnabled: Record<string, boolean>;
	multimodalOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	reasoningEffortOverrides: Record<string, "low" | "medium" | "high">;
	reasoningOverrides: Record<string, boolean>;
	billingOrganization?: string;
	/** How Alpha writes to this person; each `undefined` when left to Alpha's default. (CUR-3929) */
	tone?: Tone;
	answerLength?: Length;
	suggestions?: boolean;
	answerLanguage?: AnswerLanguage;
	plainLanguage?: boolean;
	answerFormat?: Format;
	emojis?: Emojis;
	showServing?: boolean;
	selfReferenceAsPerson?: boolean;
	/** The past-chat search switch; `undefined` is off. (CUR-4576) */
	searchPastChats?: boolean;
	/** The agent "ask before every step" switch; `undefined` is off. */
	agentAskEveryStep?: boolean;
};

export interface LayoutConversationRow {
	_id: Conversation["_id"];
	id: Conversation["_id"];
	title: string;
	updatedAt: Date;
	model?: string;
	modelId?: string;
}

/** The region conversations are stored in, as a label such as `eu-central-1`, read from the database
 *  host (CUR-4580). Only the label leaves the server, never the connection string. Undefined when the
 *  host carries no region (local dev). */
export function getLayoutStorageRegion(): string | undefined {
	return storageRegionLabel(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

export async function getLayoutPublicConfig(): Promise<LayoutPublicConfig> {
	return config.getPublicConfig() as LayoutPublicConfig;
}

export async function getLayoutFeatureFlags(locals: App.Locals): Promise<FeatureFlags> {
	// Hoisted (CUR-770) so agentEnabled and the new agentModeDefault agree by construction rather than
	// each calling agentModeEnabledForUser independently — one named binding is clearer than two inline
	// calls that happen to return the same thing. It is also one PostHog round-trip: this gate is
	// per-account (CUR-1440), and this function runs on every chat page load.
	//
	// Two per-account PostHog reads, run together rather than in sequence — this function is on the
	// chat page-load path. Signed out there is no account id to evaluate the storage gate against, so
	// that read is skipped: the surface needs an account anyway.
	const accountId = locals.user?._id?.toString();
	const [agentAllowed, custodialStorageAllowed] = await Promise.all([
		agentModeEnabledForUser(locals),
		accountId ? custodialStorageViewEnabledForUser(accountId) : Promise.resolve(false),
	]);
	return {
		enableAssistants: config.ENABLE_ASSISTANTS === "true",
		loginEnabled: loginEnabled(),
		// Ships the SAME condition handle.ts's two server-side force-login gates require alongside
		// loginEnabled, so client code can't re-derive "configured means required" from loginEnabled
		// alone — see FeatureFlags.automaticLogin and requireAuthUser (CUR-246).
		automaticLogin: config.AUTOMATIC_LOGIN === "true",
		// Only Settings' developer tools read this (settingsSections.ts), so a staff role opens them too (CUR-3992).
		isAdmin: seesDeveloperTools(locals.isAdmin, locals.user?.role),
		// Both the button and the API read the dictation gate, so the client never shows a
		// button the API would 403. (CUR-198)
		transcriptionEnabled: dictationEnabled(),
		// No scanner, no attach control. Every upload is refused server-side without one, so
		// offering the control would only lead to a refusal. (CUR-2382)
		attachmentsEnabled: csamScanConfigured(),
		// PDF and DOCX, read to text on the server. Offered only where they would be read. (CUR-987)
		documentAttachmentsEnabled: csamScanConfigured() && documentAttachmentsOffered(),
		// May THIS visitor send an image? The `multimodal` flag per account (team accounts only
		// on preview). My files reads it to decide whether to offer images at all. (CUR-2725)
		imageInputEnabled: multimodalEnabled(),
		// Per-user (CUR-121): the toggle renders only for a cleared tester, not the whole deployment. The
		// model list and turn resolution gate the same identity, so all three surfaces agree.
		agentEnabled: agentAllowed,
		// Seed a cleared tester's first-ever visit into "auto" rather than "off" — see
		// stores/agentMode.ts. Never touches a returning tester's own past choice. (CUR-770)
		agentModeDefault: agentAllowed ? "auto" : "off",
		// Deployment-wide (CUR-225). Both client surfaces — the in-message player and the composer
		// toggle's `hidden` class — read THIS value rather than the const, so they cannot disagree with
		// the server's synthesis decision about whether the feature is on.
		readAloudEnabled: readAloudEnabled(),
		// The account page's "Download your data" row, gated on the same boolean
		// routes/chat/api/v2/export reads — a visible control always leads to a request that is allowed. (CUR-1681)
		dataExportEnabled: dataExportEnabled(),
		// The account page's Thunderbolt download, gated on what routes/chat/api/v2/export/thunderbolt reads. (CUR-2407)
		thunderboltExportEnabled: thunderboltExportEnabled(),
		// Settings → Connections (Thunderbolt sync), gated on what the page and /chat/api/v2/sync read.
		// Signed out there is no account to connect. (CUR-4312)
		thunderboltSyncEnabled: Boolean(accountId) && thunderboltSyncEnabled(),
		// The Personalization switch for past-chat search. Signed out there are no chats of an
		// account to search, so it never shows. (CUR-4576)
		pastChatSearchEnabled: Boolean(accountId) && pastChatSearchEnabled(),
		// The settings nav "Storage" tab, gated on the same per-account read /chat/storage
		// 404s on. (CUR-1682)
		custodialStorageEnabled: custodialStorageAllowed,
		// Gates the settings nav "Workspace" tab and the page itself. CUR-957 split this from
		// org creation — see workspacesGate.ts. (CUR-913)
		workspacesEnabled: workspacesEnabled(),
		// Gates creating an additional workspace and inviting anyone into one — see
		// workspacesGate.ts for why this must agree with the server-side gate on better-auth's own
		// organization routes. (CUR-957)
		workspaceOrgCreationEnabled: workspaceOrgCreationEnabled(),
		// Gates the settings nav "Local Inference" tab and the page itself — see
		// localEndpointsGate.ts. Which endpoint(s) a signed-in user has is separate, per-user DB state. (CUR-1194)
		localInferenceEnabled: localInferenceEndpointsEnabled(),
		// The settings nav "Connectors" tab, gated on the same flag the page and the turn read. (CUR-3984)
		mcpServersEnabled: mcpServersEnabled(),
		// Auto model routing (autoRoutingGate.ts). Off: no Auto row in the composer's model menu, and a new
		// chat starts on the model chosen in settings.
		autoRoutingEnabled: autoRoutingEnabled(),
		// Auto picks again inside a turn its first choice did not answer (autoRepickGate.ts). (CUR-4384)
		autoRepickEnabled: autoRoutingEnabled() && autoRepickEnabled(),
		// An agent run outlives the request, and the page follows it for the run's whole ceiling. (CUR-4410)
		agentRunHandoffEnabled: agentRunHandoffEnabled(),
		// How long Auto waits on each listed model's first word, so the live log can say a model is slow to start
		// before that wait runs out (CUR-4384). Empty while the re-pick is off.
		autoRepickWaitMs:
			autoRoutingEnabled() && autoRepickEnabled()
				? Object.fromEntries(models.filter((m) => !m.unlisted).map((m) => [m.id, autoRepickGiveUpFor(m.id)]))
				: {},
		// Auto's hosted draft read (clefRoutingGate.ts). Off: the draft is read in the browser only.
		clefRoutingEnabled: autoRoutingEnabled() && clefRoutingEnabled(),
		// Where the evaluation is offered; the page and API check the same flag themselves. (CUR-1914)
		humanEvalEnabled: humanEvalEnabled(),
		// Sidebar "Files" entry — same per-user gate as /chat/storage itself. (CUR-1276)
		storageViewEnabled: custodialStorageAllowed,
		// The same cap parseRequest enforces, so the composer can refuse locally instead of
		// rendering the message as sent and then rolling it back. (CUR-1921)
		messageLengthLimit: usageLimits?.messageLength ?? null,
	};
}

export async function getLayoutModels(_locals: App.Locals): Promise<GETModelsResponse> {
	try {
		const { models: registry } = await import("$lib/chat/server/models");
		// This user's local (LAN/self-hosted) endpoint, if any (localModels.ts) — never merged into the
		// shared registry above, since that array is process-wide; appended here, per-request, so it
		// only ever appears for the user whose DB row it came from.
		const local = await resolveLocalModelsForUser(_locals);
		// The agent model is registered `unlisted: true` (models.ts), so this one filter already
		// excludes it for every caller — it's never a directly-selectable model,
		// see resolveAgentRoute.ts.
		// Parsed, not just mapped: the schema strips whatever `providers` and `parameters` carry
		// beyond the fields it names (CUR-2640). (CUR-770)
		const listed = [...registry, ...local]
			.filter((m) => m.unlisted == false)
			.map((model) => ({
				id: model.id,
				name: model.name,
				websiteUrl: model.websiteUrl,
				modelUrl: model.modelUrl,
				datasetName: model.datasetName,
				datasetUrl: model.datasetUrl,
				displayName: model.displayName,
				// Spread, not a plain key: this payload is what /api/v2/models publishes, and a bare
				// `localEndpointKind: undefined` still shows up in Object.keys(), so every catalog
				// model would advertise a field that only a local one can ever have a value for.
				// Present only where it means something.
				...(model.localEndpointKind ? { localEndpointKind: model.localEndpointKind } : {}),
				description: model.description,
				knownWeakSpot: knownWeakSpotFor(model.id),
				logoUrl: model.logoUrl,
				providers: model.providers as unknown as Array<
					{ provider: string } & Record<string, unknown>
				>,
				promptExamples: model.promptExamples,
				parameters: model.parameters,
				preprompt: model.preprompt,
				// Per request (CUR-2725): the list is shared across visitors, the image answer is not.
				multimodal: modelTakesImagesNow(model),
				multimodalAcceptedMimetypes: modelTakesImagesNow(model)
					? model.multimodalAcceptedMimetypes
					: undefined,
				supportsTools: (model as unknown as { supportsTools?: boolean }).supportsTools ?? false,
				supportsReasoning:
					(model as unknown as { supportsReasoning?: boolean }).supportsReasoning ?? false,
				supportsArtifacts:
					(model as unknown as { supportsArtifacts?: boolean }).supportsArtifacts ?? false,
				unlisted: model.unlisted,
				hasInferenceAPI: model.hasInferenceAPI,
				isRouter: model.isRouter,
			})) satisfies GETModelsResponse;
		return publicModelsSchema.parse(listed) as GETModelsResponse;
	} catch (e) {
		// Any exception here (a malformed catalog entry from a drifted gateway pool, not just a
		// still-booting registry) must not look like "no models configured", so log it like every other
		// registry failure in this file's sibling module (models.ts's ensureModelsReady) does (CUR-1154).
		logger.error(e, "[models] getLayoutModels failed; returning an empty list");
		void captureServerException(e);
		return [] as GETModelsResponse;
	}
}

export function getLayoutUser(locals: App.Locals): LayoutUser {
	return locals.user
		? {
				id: locals.user._id.toString(),
				name: locals.user.name,
				username: locals.user.username,
				avatarUrl: locals.user.avatarUrl,
				email: locals.user.email,
				isAdmin: locals.user.isAdmin ?? false,
				isEarlyAccess: locals.user.isEarlyAccess ?? false,
			}
		: null;
}

export async function getLayoutSettings(locals: App.Locals): Promise<LayoutSettings> {
	if (!locals.user?._id && !locals.sessionId) {
		return normalizeLayoutSettings({
			welcomeModalSeen: false,
			welcomeModalSeenAt: null,
			activeModel: DEFAULT_SETTINGS.activeModel,
			streamingMode: resolveStreamingMode({}),
			directPaste: DEFAULT_SETTINGS.directPaste,
			hapticsEnabled: DEFAULT_SETTINGS.hapticsEnabled,
			hidePromptExamples: DEFAULT_SETTINGS.hidePromptExamples,
			customPrompts: {},
			customPromptsEnabled: {},
			multimodalOverrides: {},
			artifactsOverrides: {},
			reasoningEffortOverrides: {},
			reasoningOverrides: {},
			billingOrganization: undefined,
		});
	}

	const settings = await collections.settings.findOne(authCondition(locals));

	// Validate against THIS user's effective registry (catalog + their own local endpoint, if any) —
	// the bare global validModelIdSchema alone would reset a valid `local:*` selection back to the
	// default every time this loads, since a per-user model never appears in the shared `models` array.
	const effectiveValidModelIdSchema = await getEffectiveValidModelIdSchema(locals);
	if (settings && !effectiveValidModelIdSchema.safeParse(settings?.activeModel).success) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	if (
		settings?.activeModel &&
		models.find((m) => m.id === settings?.activeModel)?.unlisted === true
	) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	const streamingMode = resolveStreamingMode(settings ?? {});

	return normalizeLayoutSettings({
		welcomeModalSeen: !!settings?.welcomeModalSeenAt,
		welcomeModalSeenAt: settings?.welcomeModalSeenAt ?? null,
		activeModel: settings?.activeModel ?? DEFAULT_SETTINGS.activeModel,
		streamingMode,
		directPaste: settings?.directPaste ?? DEFAULT_SETTINGS.directPaste,
		hapticsEnabled: settings?.hapticsEnabled ?? DEFAULT_SETTINGS.hapticsEnabled,
		hidePromptExamples: settings?.hidePromptExamples ?? DEFAULT_SETTINGS.hidePromptExamples,
		customPrompts: settings?.customPrompts ?? {},
		customPromptsEnabled: settings?.customPromptsEnabled ?? {},
		multimodalOverrides: config.isHuggingChat ? {} : (settings?.multimodalOverrides ?? {}),
		artifactsOverrides: settings?.artifactsOverrides ?? {},
		reasoningEffortOverrides: settings?.reasoningEffortOverrides ?? {},
		reasoningOverrides: config.isHuggingChat ? {} : (settings?.reasoningOverrides ?? {}),
		billingOrganization: settings?.billingOrganization ?? undefined,
		tone: settings?.tone ?? undefined,
		answerLength: settings?.answerLength ?? undefined,
		suggestions: settings?.suggestions ?? undefined,
		answerLanguage: settings?.answerLanguage ?? undefined,
		plainLanguage: settings?.plainLanguage ?? undefined,
		answerFormat: settings?.answerFormat ?? undefined,
		emojis: settings?.emojis ?? undefined,
		showServing: settings?.showServing ?? undefined,
		selfReferenceAsPerson: settings?.selfReferenceAsPerson ?? undefined,
		searchPastChats: settings?.searchPastChats ?? undefined,
		agentAskEveryStep: settings?.agentAskEveryStep ?? undefined,
	});
}

/** A team workspace lists its own conversations. CUR-3040: a former workspace (left or
 *  deleted) lists its own too, and Personal lists only chats from no workspace. A null scope lists (CUR-3023)
 *  everything. */
function workspaceListFilter(scope: WorkspaceScope): Record<string, unknown> {
	if (!scope) return {};
	if (scope.current) return { organizationId: scope.current.id };
	if (scope.viewingFormer) return formerWorkspaceFilter(scope.viewingFormer);
	const leftIds = scope.former.filter((w) => w.kind === "left").map((w) => w.id);
	const notIn = [...scope.memberOrgIds, ...leftIds];
	return {
		...(notIn.length ? { organizationId: { $nin: notIn } } : {}),
		...(scope.former.some((w) => w.kind === "deleted")
			? { formerWorkspaceId: { $exists: false } }
			: {}),
	};
}

export async function getLayoutConversations(
	locals: App.Locals,
	page = 0,
	scope: WorkspaceScope = null
): Promise<{ conversations: LayoutConversationRow[]; hasMore: boolean }> {
	if (!locals.user?._id && !locals.sessionId) {
		return { conversations: [], hasMore: false };
	}

	const pageSize = CONV_NUM_PER_PAGE;
	const convs = await collections.conversations
		.find({ ...authCondition(locals), ...workspaceListFilter(scope) })
		.project<Pick<Conversation, "_id" | "title" | "updatedAt" | "model">>({
			title: 1,
			updatedAt: 1,
			model: 1,
		})
		.sort({ updatedAt: -1 })
		.skip(page * pageSize)
		.limit(pageSize + 1)
		.toArray();

	const hasMore = convs.length > pageSize;
	const conversations = (hasMore ? convs.slice(0, pageSize) : convs).map((conv) => ({
		_id: conv._id,
		id: conv._id,
		title: conv.title,
		updatedAt: conv.updatedAt,
		model: conv.model,
		modelId: conv.model,
	}));

	return { conversations, hasMore };
}

export function mapConversationsForSidebar(
	rawConversations: LayoutConversationRow[],
	defaultModelId?: string
): ConvSidebar[] {
	return rawConversations.map((conv) => {
		const trimmedTitle = conv.title.trim();
		return {
			id: conv._id.toString(),
			title: trimmedTitle,
			model: conv.model ?? defaultModelId,
			updatedAt: new Date(conv.updatedAt),
		} satisfies ConvSidebar;
	});
}

export async function getLayoutConversationsForSidebar(
	locals: App.Locals,
	page = 0,
	defaultModelId?: string,
	scope: WorkspaceScope = null
): Promise<ConvSidebar[]> {
	const { conversations } = await getLayoutConversations(locals, page, scope);
	return mapConversationsForSidebar(conversations, defaultModelId);
}

export function normalizeLayoutSettings(settings: LayoutSettings): LayoutSettings {
	return {
		...settings,
		welcomeModalSeenAt: settings.welcomeModalSeenAt
			? new Date(settings.welcomeModalSeenAt)
			: null,
	};
}

export type PublicConfigKey = keyof typeof publicEnv;
