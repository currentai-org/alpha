import adapterVercel from '@sveltejs/adapter-vercel';
import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import { CSP_REPORT_GROUP, cspReportEndpoint } from './src/lib/cspReportEndpoint.js';

dotenv.config({ path: './.env.local', override: true, quiet: true });
dotenv.config({ path: './.env', quiet: true });

// Deploy target. Default is Vercel serverless (chat needs the Node runtime: postgres.js +
// Buffer/streams/sharp/satori). ADAPTER=node/static for other hosts.
const adapterChoice = process.env.ADAPTER ?? 'vercel';

// Vercel function region(s), comma-separated, read at build time from the deployment's own config
// (CUR-4534). Unset keeps Vercel's default (iad1), so only a config that names one moves.
const functionRegions = (process.env.FUNCTION_REGION ?? '')
	.split(',')
	.map((r) => r.trim())
	.filter(Boolean);

function originOf(url) {
	try {
		return url ? new URL(url).origin : undefined;
	} catch {
		return undefined;
	}
}

// CUR-1898: where the site may load images and media from. A model answer can be steered by a page
// it read, and an image it names is fetched with no click, carrying whatever the model put in the
// URL. The renderer already turns a remote image into a link; this is the browser-side backstop.
// Each host is one the app itself points at, never one a model answer could choose.
const imageSources = [
	"'self'",
	'data:',
	'blob:',
	// Payload media (the CMS's S3 bucket behind its CDN), and the CMS itself for its file route.
	'https://content.aipotluck.org',
	originOf(process.env.PUBLIC_CMS_PAYLOAD_URL),
	// Model logos (huggingface.co/api/avatars redirects to cdn-avatars) and model thumbnails.
	'https://huggingface.co',
	'https://cdn-avatars.huggingface.co',
	'https://cdn-uploads.huggingface.co',
	originOf(process.env.PUBLIC_LLM_ROUTER_LOGO_URL),
	// Sign-in avatars from Google and GitHub.
	'https://*.googleusercontent.com',
	'https://avatars.githubusercontent.com'
	// Never a PostHog host, in any region: its ingest endpoints record an event sent as an image's
	// query string, so an image pointed at someone else's PostHog project would carry data out.
	// PostHog's own capture uses fetch/sendBeacon, which img-src does not govern.
].filter(Boolean);

// CUR-3187: every origin the browser fetches from or loads a script from, enumerated from the
// client code. PostHog: its ingest host (PUBLIC_POSTHOG_HOST, which preview sets to the same-origin
// /rs proxy and production leaves on the default) and its assets host for lazy scripts.
// huggingface.co: HuggingChat mode's profile read. The CMS: Live Preview's data fetch. Tally: the
// email-signup embed. Plausible: optional, by env. The code CDNs: artifacts load from them, and a
// srcdoc frame inherits this policy.
const posthogHost = originOf(process.env.PUBLIC_POSTHOG_HOST) ?? 'https://us.i.posthog.com';
const plausibleOrigin = originOf(process.env.PUBLIC_PLAUSIBLE_SCRIPT_URL);
const codeCdns = [
	'https://cdn.tailwindcss.com',
	'https://unpkg.com',
	'https://cdn.jsdelivr.net',
	'https://cdnjs.cloudflare.com'
];
const connectSources = [
	...new Set([
		"'self'",
		posthogHost,
		'https://us.i.posthog.com',
		'https://us-assets.i.posthog.com',
		'https://huggingface.co',
		originOf(process.env.PUBLIC_CMS_PAYLOAD_URL),
		'https://tally.so',
		plausibleOrigin
	])
].filter(Boolean);
const scriptSources = [
	"'self'",
	// No nonce: the theme script is injected with {@html} and the Plausible snippet is inline, and a
	// nonce would make the browser ignore 'unsafe-inline' for every artifact, which inherits this.
	// Unquoted on purpose: SvelteKit adds its nonce unless the list holds the bare keyword
	// `unsafe-inline` (csp.js compares the raw value), and it adds the quotes itself.
	'unsafe-inline',
	'unsafe-eval',
	'https://us-assets.i.posthog.com',
	'https://tally.so',
	plausibleOrigin,
	...codeCdns
].filter(Boolean);
const cspReportUri = cspReportEndpoint(process.env);

function getGitCommitSHA() {
	try {
		return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
	} catch {
		return undefined;
	}
}

function getCurrentCommitSHA() {
	return process.env.VERCEL_GIT_COMMIT_SHA?.trim() || getGitCommitSHA() || 'unknown';
}

process.env.PUBLIC_VERSION ??= process.env.npm_package_version;
process.env.PUBLIC_COMMIT_SHA ??= getCurrentCommitSHA();
process.env.PUBLIC_APP_ASSETS ??= 'chatui';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],

	compilerOptions: {
		// Force runes mode for the os-ai map/explorer code only. Leave node_modules,
		// unplugin-icons' generated `~icons/*` components, and the merged chat subtree on
		// auto-detect — chat-ui ships a mix of runes and legacy (`export let`) components, so
		// forcing runes there would break them. Can be removed in svelte 6.
		runes: ({ filename }) => {
			const f = filename.replace(/\\/g, '/');
			if (f.includes('/node_modules/') || f.includes('~icons') || f.includes('unplugin-icons'))
				return undefined;
			if (f.includes('/src/lib/chat/') || f.includes('/src/routes/chat/')) return undefined;
			return true;
		}
	},

	kit: {
		adapter:
			adapterChoice === 'static'
				? adapterStatic({ fallback: 'index.html', strict: false })
				: adapterChoice === 'node'
					? adapterNode()
					: // Vercel serverless on the Node runtime — chat needs postgres.js + Node APIs.
						adapterVercel({
							runtime: 'nodejs22.x',
							...(functionRegions.length ? { regions: functionRegions } : {})
						}),
		paths: {
			// Empty app-wide: the map owns "/" and the chat lives under the filesystem route
			// /chat (its code builds URLs via the $lib/chat/paths `base = "/chat"` constant).
			base: ''
		},
		alias: {
			// Every reusable Payload block component (Button, Cards, Faqs, IconGrid, TextMedia,
			// EmailSignup, ...) — mirrors the `@blocks` alias already used on the payload/ side
			// (payload/tsconfig.json), so a block's import path reads the same regardless of
			// which app you're in.
			'@blocks': 'src/lib/components/blocks',
			'@blocks/*': 'src/lib/components/blocks/*',
			'@templates': 'src/lib/components/page-templates',
			'@templates/*': 'src/lib/components/page-templates/*'
		},
		csrf: {
			// Chat handles CSRF in its own hook (multiple valid origins).
			trustedOrigins: ['*']
		},
		csp: {
			directives: {
				'img-src': imageSources,
				// Read-aloud plays a clip it fetched itself, from a blob: URL (loadAudioClip.ts).
				'media-src': ["'self'", 'data:', 'blob:'],
				// CUR-3187: no <base href> may repoint relative URLs, and a form may submit only here, to
				// the Contribute dialog's Tally form (a GET in a new tab), or on to huggingface.co.
				// Chrome checks form-action against every redirect a submission follows, and Settings →
				// Storage's Connect Hugging Face form GETs our connect route, which 303s to Hugging Face's
				// OAuth consent; without huggingface.co the browser drops that navigation and the
				// button does nothing.
				'base-uri': ["'self'"],
				'form-action': ["'self'", 'https://tally.so', 'https://huggingface.co'],
				// Enforced once seven days of CSP reports showed nothing legitimate outside these lists
				// (CUR-3188).
				'connect-src': connectSources,
				'script-src': scriptSources,
				// Without its own list worker-src falls back to script-src, which has no blob:, and a
				// srcdoc artifact inherits this policy, so every artifact worker would stop
				// (previewSrcdoc.ts allows `worker-src blob:` for them).
				'worker-src': ["'self'", 'blob:'],
				// An artifact script can navigate its own srcdoc frame anywhere, and only the
				// embedding page's frame-src can stop that (CUR-3188). The app frames nothing else but the notebooks
				// block's OSO marimo pages and the Tally popup, whose embed widget (lib/tally.ts) opens the
				// form in a tally.so iframe; srcdoc frames make no fetch, so frame-src leaves the artifact
				// previews themselves alone. Every notebook src on the production CMS is www.oso.xyz, which
				// 301s to www.artio.so, and a browser checks each hop of a framed redirect, so both are
				// needed while the CMS srcs point at oso.xyz.
				'frame-src': ["'self'", 'https://www.oso.xyz', 'https://www.artio.so', 'https://tally.so'],
				// Without a report-uri an enforced block is silent, so a legitimate origin missing from a
				// list above would break with nothing in PostHog to say so. report-to names the Reporting
				// API group that hooks.server.ts declares in Reporting-Endpoints: a browser that supports
				// it batches reports and ignores report-uri, which stays for the ones that don't (Firefox).
				...(cspReportUri ? { 'report-uri': [cspReportUri], 'report-to': [CSP_REPORT_GROUP] } : {}),
				...(process.env.ALLOW_IFRAME === 'true'
					? {}
					: {
							// Also allow the Payload CMS admin origin, for its Live Preview iframe.
							'frame-ancestors': [
								'https://huggingface.co',
								...(process.env.PUBLIC_CMS_PAYLOAD_URL ? [process.env.PUBLIC_CMS_PAYLOAD_URL] : [])
							]
						})
			}
		},
		prerender: {
			// Payload-backed content routes ([...slug], /) set `prerender = false` on themselves.
			// `'*'` crawls the rest.
			entries: ['*'],
			handleHttpError({ path, message }) {
				// The /chat subtree is dynamic (auth/DB/streaming) and opts out of prerender;
				// ignore any crawl links into it rather than failing the build.
				if (path === '/chat' || path.startsWith('/chat/')) return;
				throw new Error(message);
			},
			// A prerenderable route that produced no pages is normally a bug and fails the build.
			// The chat surface (APP_SURFACE=chat, CUR-4448) is the exception for routes outside /chat:
			// `reroute` maps every crawled path into the /chat tree, so a site route such as /roadmap-v2
			// is unreachable there by design. Read from the env here because src/lib/surface.ts's
			// APP_SURFACE comes from Vite's `define`, which config time does not have; vite.config.ts
			// rejects any value other than unset, "site" or "chat".
			handleUnseenRoutes({ routes }) {
				const chatSurface = process.env.APP_SURFACE?.trim() === 'chat';
				const unseen = chatSurface
					? routes.filter((id) => id === '/chat' || id.startsWith('/chat/'))
					: routes;
				if (unseen.length > 0) {
					throw new Error(
						'The following routes were marked as prerenderable, but were not prerendered ' +
							'because they were not found while crawling your app:\n' +
							unseen.map((id) => `  - ${id}`).join('\n')
					);
				}
			}
		}
	}
};

export default config;
