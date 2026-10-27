// Which paths in the one web/ app belong to chat, which to the site, and where each product imports the
// other (CUR-2458). Two readers:
//
// - `scripts/lib/e2eRunScope.mjs` scopes a PR's scenario run to @chat specs, @site specs, or both.
// - `scripts/check-product-boundary.mjs` fails a cross-product import that SITE_IMPORTS_OF_CHAT or
//   CHAT_IMPORTS_OF_SITE below does not list, so the two lists stay the true map of where the products
//   touch.
//
// Paths are repo-relative. Anything matching neither CHAT nor SITE scopes to both products: a shared
// file (the hooks, the root layout, alpha-ds, app.css, configs, the lockfile) can break either, and a
// path nobody classified has no grounds to skip anything.

export const CHAT = [
	/^web\/src\/lib\/chat\//,
	/^web\/src\/routes\/chat\//,
	// Potluck Run, the hidden game behind the new-chat mark: opened from the chat and leading back into it.
	/^web\/src\/lib\/potluck-run\//,
	// Chat's OpenAI-compatible adapter for preview inference: an API, no page, and every import it
	// makes is chat server code.
	/^web\/src\/routes\/folkways-adapter\//,
	// The OAuth discovery document for chat's sync clients (CUR-4312): RFC 8414 puts it at the origin
	// root, outside /chat, but it describes only chat's auth server and imports only chat code.
	/^web\/src\/routes\/\.well-known\/oauth-authorization-server\//
];

export const SITE = [
	/^web\/src\/lib\/(alpha-landing|gapmap|payload|roadmap|data|lexical)\//,
	/^web\/src\/lib\/server\/gapMap\//,
	// Site page components and the header and footer. The chat app renders neither the site header nor
	// the footer (`isChatApp` in routes/+layout.svelte), and no chat file imports these; the import check
	// below fails one that starts to. error-card, seo and ui stay shared: chat imports them.
	/^web\/src\/lib\/components\/(blocks|content-blocks|entity|hero|home-hero|map-intro|overview|page-templates|panels|product-list-table|product-score-table|products-table|recent-updates|social-links|stats-hero|stats-panel|stroke-loop|updates|updates-item|updates-list)\//,
	/^web\/src\/lib\/components\/site-(header|footer)(-tone)?\.(svelte|ts)$/,
	/^web\/src\/lib\/assets\/(icons|maturity|patterns|update-tags)\//,
	/^web\/src\/routes\/(\[\.\.\.slug\]|org|product|roadmap-v2|rs|sitemap\.xml|updates|designsystem|alpha|api)\//,
	/^web\/src\/routes\/\+page\.(svelte|server\.ts)$/,
	/^payload\//
];

// Every chat module a non-chat file under web/src imports, keyed by the importing file. Two jobs:
//
// 1. The import check fails any site → chat import not listed here, so a new edge is a deliberate edit
//    to this file, reviewed in its PR, not something that accumulates unseen.
// 2. A change to one of these chat modules can break a site page without breaking a chat page, so the
//    scope rule sends it to both products.
//
// The second job is direct imports only. A chat module these import in turn is not followed: a change
// there reaches the site only through one of these, and the full suite on every develop push is the
// backstop for that path.
//
// Test files (*.spec.ts) are not listed: they import what they test and ship nothing. Generated from
// the tree once; edit by hand from here on.
export const SITE_IMPORTS_OF_CHAT = {
	'web/src/lib/alpha-landing/looks/bold/BoldClosing.svelte': [
		'$lib/chat/components/PotluckMark.svelte'
	],
	'web/src/lib/alpha-landing/looks/bold/BoldFeatures.svelte': [
		'$lib/chat/components/bentos/DataBento.svelte',
		'$lib/chat/components/bentos/FootprintBento.svelte',
		'$lib/chat/components/bentos/InstructionsBento.svelte',
		'$lib/chat/components/bentos/LanguageBento.svelte',
		'$lib/chat/components/bentos/ModelBento.svelte',
		'$lib/chat/components/bentos/ThemeBento.svelte',
		'$lib/chat/components/bentos/XRayBento.svelte'
	],
	'web/src/lib/alpha-landing/looks/bold/BoldLook.svelte': [
		'$lib/chat/components/PotluckMark.svelte'
	],
	'web/src/lib/alpha-landing/looks/classic/ClassicFeatures.svelte': [
		'$lib/chat/components/bentos/DataBento.svelte',
		'$lib/chat/components/bentos/FootprintBento.svelte',
		'$lib/chat/components/bentos/InstructionsBento.svelte',
		'$lib/chat/components/bentos/LanguageBento.svelte',
		'$lib/chat/components/bentos/ModelBento.svelte',
		'$lib/chat/components/bentos/ThemeBento.svelte',
		'$lib/chat/components/bentos/XRayBento.svelte'
	],
	'web/src/lib/alpha-landing/looks/handover/HandoverFeatures.svelte': [
		'$lib/chat/components/bentos/DataBento.svelte',
		'$lib/chat/components/bentos/FootprintBento.svelte',
		'$lib/chat/components/bentos/InstructionsBento.svelte',
		'$lib/chat/components/bentos/LanguageBento.svelte',
		'$lib/chat/components/bentos/ModelBento.svelte',
		'$lib/chat/components/bentos/ThemeBento.svelte',
		'$lib/chat/components/bentos/XRayBento.svelte'
	],
	'web/src/app.d.ts': ['$lib/chat/types/User'],
	'web/src/lib/analytics.ts': ['$lib/chat/paths'],
	'web/src/hooks.server.ts': [
		'$lib/chat/paths',
		'$lib/chat/server/db/client',
		'$lib/chat/server/env/validate',
		'$lib/chat/server/errorTracking',
		'$lib/chat/server/guestHandoff',
		'$lib/chat/server/hooks/error',
		'$lib/chat/server/hooks/fetch',
		'$lib/chat/server/hooks/handle',
		'$lib/chat/server/hooks/init',
		'$lib/chat/server/legacySessionCookie',
		'$lib/chat/server/logger',
		'$lib/chat/wwwChatRedirect'
	],
	'web/src/hooks.ts': ['$lib/chat/utils/PublicConfig.svelte'],
	'web/src/lib/alpha-landing/AlphaDemoClient.svelte': [
		'$lib/chat/components/ChatShell.svelte',
		'$lib/chat/components/chat/ChatWindow.svelte',
		'$lib/chat/stores/stack',
		'$lib/chat/types/EmbeddedIntent',
		'$lib/chat/types/Message'
	],
	'web/src/lib/alpha-landing/AlphaDemoSignUp.svelte': [
		'$lib/chat/components/SignInHero.svelte',
		'$lib/chat/paths'
	],
	'web/src/lib/alpha-landing/copy.ts': [
		'$lib/chat/constants/retention',
		'$lib/chat/contribute',
		'$lib/chat/paths',
		'$lib/chat/routing/catalog'
	],
	'web/src/lib/alpha-landing/demo-api-interceptor.ts': [
		'$lib/chat/demoApiFetch',
		'$lib/chat/paths',
		'$lib/chat/types/WipeSummary'
	],
	'web/src/lib/alpha-landing/demo-conversation.ts': [
		'$lib/chat/contribute',
		'$lib/chat/paths',
		'$lib/chat/routing/catalog',
		'$lib/chat/types/Message',
		'$lib/chat/types/MessageTimings',
		'$lib/chat/types/MessageUpdate',
		'$lib/chat/types/Rag',
		'$lib/chat/types/Search',
		'$lib/chat/utils/energyEstimate'
	],
	'web/src/lib/alpha-landing/demo-models.ts': [
		'$lib/chat/routing/catalog',
		'$lib/chat/routing/wwwPicker',
		'$lib/chat/server/api/types',
		'$lib/chat/types/Model'
	],
	'web/src/lib/alpha-landing/demo-page-data.ts': [
		'$lib/chat/chromeCopy',
		'$lib/chat/constants/starterShelf',
		'$lib/chat/search/triggerStrategy',
		'$lib/chat/server/chatShellData',
		'$lib/chat/servingProvenance',
		'$lib/chat/types/ConvSidebar',
		'$lib/chat/utils/starterRotation'
	],
	'web/src/lib/alpha-landing/demo-sidebar.ts': ['$lib/chat/types/ConvSidebar'],
	'web/src/lib/payload/links.ts': ['$lib/chat/paths'],
	'web/src/lib/payload/paintDeadline.ts': ['$lib/chat/server/flags'],
	'web/src/lib/payload/preview.server.ts': ['$lib/chat/server/crypto'],
	'web/src/lib/server/devOnlyRoute.ts': ['$lib/chat/server/deployEnv'],
	'web/src/lib/server/gapMap/pageRead.ts': ['$lib/chat/server/textGeneration/faultInjection'],
	'web/src/lib/server/gapMap/stackXRay.ts': [
		'$lib/chat/components/stack/provenanceProducts.generated'
	],
	'web/src/routes/alpha/demo/+page.svelte': ['$lib/chat/components/PotluckMark.svelte'],
	'web/src/routes/api/cms/invalidate/+server.ts': [
		'$lib/chat/server/api/utils/json',
		'$lib/chat/server/crypto',
		'$lib/chat/server/logger',
		'$lib/chat/server/rag/policyPageSync',
		'$lib/chat/server/vercelBackground'
	],
	'web/src/routes/api/data-freshness/+server.ts': ['$lib/chat/server/api/utils/json']
};

// The reverse direction: every site module a chat file imports, keyed by the importing chat file. A
// change to one of these site modules can break a chat page, so it scopes to both products. Same rules
// as above: direct imports only, test files left out.
export const CHAT_IMPORTS_OF_SITE = {
	'web/src/lib/chat/components/ChatBackdrop.svelte': ['$lib/alpha-landing/alpha-potluck-field'],
	'web/src/lib/chat/components/ChatShell.svelte': ['$lib/alpha-landing/demo-sidebar'],
	'web/src/lib/chat/components/bentos/XRayBento.svelte': ['$lib/alpha-landing/demo-conversation'],
	'web/src/lib/potluck-run/pieceFaces.ts': ['$lib/alpha-landing/canvas-shapes'],
	'web/src/lib/potluck-run/engine.ts': [
		'$lib/alpha-landing/alpha-potluck-field',
		'$lib/alpha-landing/canvas-shapes'
	],
	'web/src/lib/chat/server/rag/policyPageSync.ts': ['$lib/lexical/types'],
};
