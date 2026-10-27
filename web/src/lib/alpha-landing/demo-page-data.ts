import { shelf } from '$lib/chat/constants/starterShelf';
import { resolveTriggerStrategy } from '$lib/chat/search/triggerStrategy';
import type { loadChatShellData } from '$lib/chat/server/chatShellData';
import { resolveServing } from '$lib/chat/servingProvenance';
import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
import { STARTER_COUNT, pickRotatingStarters } from '$lib/chat/utils/starterRotation';
import { DEMO_MODEL_ID, demoModels } from './demo-models';
import { chromeLanguage } from '$lib/chat/chromeCopy';

/**
 * What /chat's layout load hands the app, with the sample conversations in place of a person's.
 * Typed from that loader, so a field added there fails `pnpm check` here until the demo supplies it.
 */
export type DemoShellData = Omit<Awaited<ReturnType<typeof loadChatShellData>>, 'conversations'> & {
	conversations: ConvSidebar[];
};

/** The part chat components read from `page.data`; the conversations belong to the shell alone. */
export type DemoPageData = Omit<DemoShellData, 'conversations'>;

// Production's lane: the LiteLLM gateway, which the deployment's SOVEREIGN_HOSTS marks sovereign.
// Passing both keeps the greeting and the footprint card wording identical to /chat.
const GATEWAY_BASE_URL = 'https://api-internal.publicai.co/v1';
const SOVEREIGN_HOSTS = 'api-internal.publicai.co=Public AI Inference Utility';

/**
 * The payload chat components read from `page.data` (greeting, serving line, retention copy, prompt
 * examples, feature gates), built from the same registries the server uses.
 */
export function createDemoPageData(locale: string = 'en'): DemoPageData {
	return {
		// The root locale is resolved on the server and reused during hydration.
		uiLang: chromeLanguage(locale),
		servingProvenance: resolveServing(GATEWAY_BASE_URL, DEMO_MODEL_ID, SOVEREIGN_HOSTS),
		// The chat database's region, for X-ray's "Stored in" hop.
		storageRegion: 'eu-central-1',
		safetyRules: [],
		// No server, so no geo header: the support card stays generic in the demo.
		visitorCountry: null,
		searchTriggerStrategy: resolveTriggerStrategy(undefined),
		starters: pickRotatingStarters(shelf, STARTER_COUNT),
		publicConfig: {
			PUBLIC_APP_ASSETS: 'chatui',
			PUBLIC_ORIGIN: typeof window !== 'undefined' ? window.location.origin : '',
			PUBLIC_APP_DESCRIPTION: 'Alpha demo',
			PUBLIC_POSTHOG_KEY: '',
			PUBLIC_POSTHOG_HOST: ''
		},
		// Every gate that would call a service the demo has no backend for stays off.
		enableAssistants: false,
		loginEnabled: true,
		automaticLogin: false,
		isAdmin: false,
		transcriptionEnabled: false,
		attachmentsEnabled: false,
		documentAttachmentsEnabled: false,
		imageInputEnabled: false,
		agentEnabled: false,
		agentModeDefault: 'off',
		readAloudEnabled: false,
		dataExportEnabled: false,
		thunderboltExportEnabled: false,
		thunderboltSyncEnabled: false,
		pastChatSearchEnabled: false,
		custodialStorageEnabled: false,
		workspacesEnabled: false,
		workspaceOrgCreationEnabled: false,
		localInferenceEnabled: false,
		mcpServersEnabled: false,
		// The demo shows the whole product, Auto included.
		autoRoutingEnabled: true,
		// The demo never sends a turn, so no turn of its fails for Auto to pick again.
		autoRepickEnabled: false,
		// The demo never sends a turn, so no agent run outlives one.
		agentRunHandoffEnabled: false,
		autoRepickWaitMs: {},
		// The demo never sends anything: its drafts are read on the device.
		clefRoutingEnabled: false,
		// The demo links nowhere it can't show.
		humanEvalEnabled: false,
		storageViewEnabled: false,
		messageLengthLimit: null,
		models: demoModels,
		busyModels: [] as string[],
		// The demo has no server to re-read the busy marks from.
		busyRefreshMs: null,
		user: null,
		currentWorkspace: null,
		workspaces: [],
		pendingInvitations: [],
		formerWorkspaces: [],
		viewingFormer: null,
		settings: {
			welcomeModalSeen: true,
			welcomeModalSeenAt: new Date('2026-10-01T10:00:00.000Z'),
			activeModel: DEMO_MODEL_ID,
			streamingMode: 'smooth',
			directPaste: false,
			hapticsEnabled: false,
			hidePromptExamples: {},
			customPrompts: {},
			customPromptsEnabled: {},
			multimodalOverrides: {},
			artifactsOverrides: {},
			reasoningEffortOverrides: {},
			reasoningOverrides: {}
		},
		maintenanceBanner: { enabled: false, message: '' }
	};
}
