// Which paths in the one web/ app belong to chat, which to the site, and where each product imports the
// other. Two readers:
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
	/^web\/src\/routes\/folkways-adapter\//
];

export const SITE = [
	/^web\/src\/lib\/(alpha-landing|gapmap|payload|roadmap|data|lexical)\//,
	/^web\/src\/lib\/server\/gapMap\//,
	// The website's own side of the seams in $lib/website*.ts (the site chrome and its layout data), and
	// the seam only the /alpha landing imports.
	/^web\/src\/lib\/website\//,
	/^web\/src\/lib\/website(Alpha|Links)\.ts$/,
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

// The app shell: the hooks and app types, of which one SvelteKit app has exactly one. Chat keeps it
// when it moves to the public repo, so its chat imports are not crossings. Every site page still runs
// through it today. The site gets its own minimal hooks (CSP, locale, CMS and alias redirects, error
// reporting) when it becomes its own app. Until then the shell reaches site code only through the
// $lib/website* seams, which tolerate the site's absence; the check fails a direct site import here.
// Shell files match neither CHAT nor SITE, so a change to one runs both products' specs.
export const SHELL = [/^web\/src\/hooks(\.server)?\.ts$/, /^web\/src\/app\.d\.ts$/];

// The chat modules the shell imports by name, keyed by shell file. Each must resolve at build time, so
// the site cannot build from a tree without chat while one is listed. A change to one runs the site's
// specs too (pathProducts reads this). Same rules as the maps below: an unlisted import fails, and so
// does a listed one the file no longer makes. The hooks reach chat through SEAM_LOADS_OF_CHAT instead;
// app.d.ts's import is a type, erased from the build.
export const SHELL_IMPORTS_OF_CHAT = {
	'web/src/app.d.ts': ['$lib/chat/types/User']
};

// The chat modules the shell loads through `import.meta.glob`, keyed by shell file: the shell's seam
// into chat, the mirror of SEAM_LOADS_OF_SITE. A glob that matches no file is an empty object, so the
// site builds from a tree with chat's files removed, and the shell skips each chat-only branch when its
// module is absent; the site-only path runs on the site's own code. With chat present they
// load as the imports they replaced, and the site surface (develop, previews) still runs them, so a
// change to one runs the site's specs too (pathProducts reads this). The import check reads the glob
// literals in the shell, so an unlisted glob fails, and so does a listed one the file no longer makes.
// Exact glob paths, extension included.
export const SEAM_LOADS_OF_CHAT = {
	'web/src/hooks.server.ts': [
		'$lib/chat/paths.ts',
		'$lib/chat/server/cmsPublish.ts',
		'$lib/chat/server/db/client.ts',
		'$lib/chat/server/env/validate.ts',
		'$lib/chat/server/errorTracking.ts',
		'$lib/chat/server/flags.ts',
		'$lib/chat/server/guestHandoff.ts',
		'$lib/chat/server/guestHandoffPage.ts',
		'$lib/chat/server/hooks/error.ts',
		'$lib/chat/server/hooks/fetch.ts',
		'$lib/chat/server/hooks/handle.ts',
		'$lib/chat/server/hooks/init.ts',
		'$lib/chat/server/legacySessionCookie.ts',
		'$lib/chat/server/logger.ts',
		'$lib/chat/wwwChatRedirect.ts'
	],
	'web/src/hooks.ts': ['$lib/chat/utils/PublicConfig.svelte.ts']
};

// Every chat module a site or shared file under web/src imports (the shell aside), keyed by the
// importing file. Two jobs:
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
export const SITE_IMPORTS_OF_CHAT = {};

// Site modules that a shared seam ($lib/website.ts, website.server.ts, websiteChrome.ts, websiteSeo.ts)
// loads through `import.meta.glob`, keyed by the seam. Chat reaches the website only through these
// seams, so that a build without the website (the public snapshot) still compiles: a glob that matches
// no file is an empty object, not an error. The import check reads the glob literals, so this list stays
// the true map, and the scope rule treats each target as one a chat page can break, as it did when chat
// imported them directly. Exact glob paths, extension included.
export const SEAM_LOADS_OF_SITE = {
	'web/src/lib/website.ts': ['$lib/gapmap/entityUrl.ts'],
	'web/src/lib/website.server.ts': [
		'$lib/payload/cached-client.ts',
		'$lib/website/siteOnly.ts',
		'$lib/payload/client.ts',
		'$lib/payload/alpha-landing.ts',
		'$lib/payload/preview.server.ts',
		'$lib/roadmap/roadmapPublic.generated.ts',
		'$lib/payload/redirects-cached.ts',
		'$lib/payload/log.ts',
		'$lib/payload/hostServices.ts',
		'$lib/payload/invalidationKeys.ts',
		'$lib/website/layoutData.ts'
	],
	'web/src/lib/websiteChrome.ts': ['$lib/website/SiteChrome.svelte']
};

// The reverse direction: every site module a chat file imports, keyed by the importing chat file. A
// change to one of these site modules can break a chat page, so it scopes to both products. Same rules
// as above: direct imports only, test files left out.
export const CHAT_IMPORTS_OF_SITE = {};

// Every module outside chat and site code that chat reaches, directly or through other such modules,
// keyed by repo-relative path (paraglide's generated messages count as one module). Chat moves to the
// public alpha repo and takes these with it, so each one says what happens to it there:
//
// - `moves`: it is chat's, and goes with chat. `siteImporters` is how many site files still import it:
//   each of those needs its own copy or a direct library call before the site can stand alone. The
//   check fails when the count changes, so a new site import goes red, and a PR that removes one
//   lowers the number, which only ever falls.
// - `split`: each product keeps its own copy (the message catalogs, locale routing, the error card), so
//   the site may go on importing it.
// - `seam`: chat's way into the website (website.ts, website.server.ts, websiteSeo.ts). It goes with
//   chat and returns "no website" when the site's files are absent.
//
// A module chat starts to reach fails the check until it is listed, so a new shared dependency is a
// reviewed edit, and a listed module chat no longer reaches fails as stale. Test files are not walked.
export const SHARED_REACHED_BY_CHAT = {
	// Reached through the app shell (SHELL): the request plumbing both products' hooks need (content
	// negotiation, CDN cache headers, the CSP report endpoint, locale, the expired-preview page) and the
	// gap map types app.d.ts declares for site pages. Each app keeps its own copy at the split.
	'web/src/lib/acceptNegotiation.ts': { disposition: 'split' },
	'web/src/lib/analytics.ts': { disposition: 'moves', siteImporters: 9 },
	'web/src/lib/cache/cdn.ts': { disposition: 'split' },
	'web/src/lib/canvas-shapes.ts': { disposition: 'split' },
	'web/src/lib/components/error-card/error-card.svelte': { disposition: 'split' },
	'web/src/lib/components/ui/banner/banner.svelte': { disposition: 'moves', siteImporters: 0 },
	'web/src/lib/components/ui/banner/index.ts': { disposition: 'moves', siteImporters: 0 },
	'web/src/lib/cspReportEndpoint.js': { disposition: 'split' },
	'web/src/lib/deployment.ts': { disposition: 'moves', siteImporters: 3 },
	'web/src/lib/favicon.ts': { disposition: 'moves', siteImporters: 1 },
	'web/src/lib/i18n/client.svelte.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/CopyEditLayer.svelte': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/CopyEditPanel.svelte': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/catalogs.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/editsFile.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/entry.svelte.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/fileSave.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/markers.ts': { disposition: 'split' },
	'web/src/lib/i18n/copyEdit/state.svelte.ts': { disposition: 'split' },
	'web/src/lib/i18n/locales.ts': { disposition: 'split' },
	'web/src/lib/i18n/routing.ts': { disposition: 'split' },
	'web/src/lib/i18n/server.ts': { disposition: 'split' },
	'web/src/lib/paraglide': { disposition: 'split' },
	'web/src/lib/posthogUpstream.js': { disposition: 'moves', siteImporters: 1 },
	'web/src/lib/server/expiredPreview.ts': { disposition: 'split' },
	'web/src/lib/server/runtimeEnv.js': { disposition: 'moves', siteImporters: 1 },
	'web/src/lib/surface.ts': { disposition: 'moves', siteImporters: 2 },
	'web/src/lib/types/category.ts': { disposition: 'split' },
	'web/src/lib/types/scores.ts': { disposition: 'split' },
	'web/src/lib/utils.ts': { disposition: 'split' },
	'web/src/lib/website.server.ts': { disposition: 'seam' },
	'web/src/lib/website.ts': { disposition: 'seam' },
	'web/src/lib/websiteSeo.ts': { disposition: 'seam' }
};

// Site modules that a file in SHARED_REACHED_BY_CHAT imports by name, keyed by the importing file. Each
// one is site code chat carries with it into the public repo. Same rules as the maps above: an unlisted
// edge fails, and so does a listed one the file no longer makes. The goal is an empty map.
export const SHARED_IMPORTS_OF_SITE = {
	// A type-only import, erased from the build, that the type check in the public repo still needs.
	'web/src/lib/website.server.ts': ['$lib/alpha-landing/content']
};
