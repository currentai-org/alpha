// The areas inside chat, and which chat source paths belong to each (CUR-2775). A PR whose live files are
// all chat code, and all inside the areas below, runs only the @chat specs tagged for those areas, plus
// the smoke specs and its own ticket's specs. Read by `scripts/lib/e2eRunScope.mjs`; every @chat spec
// names its areas on a line of its own, `// e2e-area: @composer @storage`, and
// `scripts/check-product-boundary.mjs` fails a @chat spec without one.
//
// What keeps this from skipping a spec that would have gone red:
//
// - A chat path that matches no area runs every @chat spec, as before. So does one any site file
//   imports (config/product-boundary.mjs), since that already runs both products.
// - A module the turn path imports stays out of every area, whatever its name says: the conversation
//   endpoint, textGeneration, ChatShell, ChatWindow and ChatMessage reach it on every turn, so nearly
//   every spec exercises it. `server/mcp`, `currentWorkspace`, `workspacesGate`, the server's
//   `agentMode`, `messageProvenance` and `stores/deleteAll` are left out for that reason, as are
//   `server/auth.ts` and `betterAuth.ts`, which every request runs. Map a file only after checking
//   nothing on that path imports it.
// - Every develop push runs the whole suite (scenario-suite-check.yml's push trigger, SOL-129), so a
//   break that crosses areas is still caught; scoping moves when it is found, never whether.
//
// `turn` names specs about the turn itself (answers, streaming, lanes, refusals). No path maps to it:
// the code those specs drive is the turn path, which runs every @chat spec anyway.

const CHAT = 'web/src/lib/chat/';
const ROUTES = 'web/src/routes/chat/';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const under = (prefix, rest) => new RegExp(`^${esc(prefix)}${rest}`);

export const CHAT_AREAS = {
	composer: [
		under(
			CHAT,
			'components/chat/(ChatInput|FileDropzone|UploadedFile|AttachmentNotice|VoiceRecorder|composerTools)\\b'
		),
		under(CHAT, 'components/(voice|players)/'),
		under(CHAT, 'server/files/'),
		under(CHAT, 'server/(documentAttachmentsGate|transcribeFetch|speak)\\.ts$'),
		under(CHAT, 'stores/(pendingChatInput|speakMode|speakState)\\.ts$'),
		under(ROUTES, 'api/transcribe/')
	],
	auth: [
		under(CHAT, '(authClient|authErrorMessages|authProviderMeta)\\.ts$'),
		under(CHAT, 'components/AccountMenu\\.svelte$'),
		under(CHAT, 'server/(accountRolloutProbe|authOrigins)\\.ts$'),
		under(ROUTES, '(login|logout)/'),
		under(ROUTES, 'settings/\\(nav\\)/account/')
	],
	settings: [
		under(ROUTES, 'settings/'),
		under(CHAT, 'components/settings/'),
		under(CHAT, 'settingsSections\\.ts$')
	],
	storage: [
		under(CHAT, 'components/storage/'),
		under(CHAT, 'server/storage/'),
		under(CHAT, 'server/(formerWorkspaces|resumeWorkspace|workspaceUsage)\\.ts$'),
		under(CHAT, '(workspaceLandedNotice|workspacePermissions)\\.ts$'),
		under(ROUTES, '(storage|workspace)/'),
		under(ROUTES, 'api/storage/'),
		under(ROUTES, 'api/v2/former-workspace/'),
		under(ROUTES, 'settings/(\\(nav\\)/)?(storage|workspace)/')
	],
	agent: [
		under(
			CHAT,
			'server/(agentArtifactDownload|agentConfirmUi|deleteAgentServiceData|migrateAgentTrust)\\.ts$'
		),
		under(CHAT, 'components/chat/AgentConfirmPrompt\\.svelte$'),
		under(ROUTES, 'conversation/\\[id\\]/agent-')
	],
	provenance: [
		under(CHAT, 'components/(provenance|stack)/'),
		under(CHAT, 'provenanceLine\\.ts$'),
		under(ROUTES, 'api/v2/conversations/\\[id\\]/provenance/')
	],
	models: [
		under(ROUTES, 'models/'),
		under(ROUTES, 'api/v2/models/'),
		under(ROUTES, 'settings/\\(nav\\)/(models|\\[\\.\\.\\.model\\]|routing|local-inference)/'),
		// The CLI pairing link and its poll, which end in the local-inference settings list. (CUR-4110)
		under(ROUTES, '(api/v2/)?local-inference/')
	],
	history: [
		under(
			CHAT,
			'components/(NavMenu|NavConversationItem|NavConversationsSkeleton|ChatSearchDialog|RenameConversationDialog|DeleteConversationModal|DeleteAllConversationsModal)\\.svelte$'
		)
	],
	admin: [under(ROUTES, 'admin/'), under(CHAT, 'server/admin(Auth|Roles)\\.ts$')],
	turn: []
};
