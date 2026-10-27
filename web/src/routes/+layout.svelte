<script lang="ts">
	import { unlocalizedPath } from '$lib/i18n/routing';
	import { syncInterfaceLocale } from '$lib/i18n/client.svelte';
	import { page } from '$app/state';
	import { SiteChrome } from '$lib/websiteChrome';
	import '../app.css';
	// The latin faces the first screen needs, preloaded so they arrive alongside the JS rather than after
	// the client-rendered welcome has painted in a fallback face (CUR-2385). Same files as
	// styles/fonts-self-hosted.css, so Vite emits one hashed asset for both.
	import jakartaLatin from '@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url';
	import notoSerifLatin from '@fontsource-variable/noto-serif/files/noto-serif-latin-wght-normal.woff2?url';
	// The site header's chevron and icons are glyphs from this font; it is preloaded because otherwise it is
	// only requested once the first paint needs it, and the header paints without them (CUR-2269).
	import iconsCss from '$lib/icons/icons.generated.css?raw';
	import { iconFontUrlFrom } from '$lib/icons/fontUrl';
	const iconFontUrl = iconFontUrlFrom(iconsCss);

	import { onMount, type Component } from 'svelte';
	import { initCopyEdit, loadCopyEditLayer } from '$lib/i18n/copyEdit/entry.svelte';
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import { navigating } from '$app/state';
	import { env } from '$env/dynamic/public';
	import {
		initAnalytics,
		markInternalIfNeeded,
		registerArrivalSource,
		capturePageview
	} from '$lib/analytics';
	import { usePageTransition } from '$lib/scroll/page-transition';

	let { children, data } = $props();
	// The server resolves each page's language; keep the browser's reactive locale on it.
	$effect.pre(() => syncInterfaceLocale(data.locale));

	// Site-wide PostHog — ONE project, ONE singleton (init is idempotent). Native $pageview fires on
	// every route (/chat included) so the whole site is instrumented uniformly; posthog auto-fires
	// the matching $pageleave. The chat layout emits its additional events (session_started, …)
	// against this same instance.
	afterNavigate(({ to }) => {
		initAnalytics(env.PUBLIC_POSTHOG_KEY, env.PUBLIC_POSTHOG_HOST, env.PUBLIC_POSTHOG_UI_HOST);
		markInternalIfNeeded();
		if (to) {
			registerArrivalSource(to.url); // first-touch arrival source; guarded to once per session
			capturePageview();
		}
	});

	// app.css makes scrolling smooth for in-page `#…` jumps. A navigation to another page switches
	// it off until SvelteKit has reset the scroll position, so the new page starts at the top
	// instead of gliding there from the old page's scroll position.
	beforeNavigate(({ from, to }) => {
		if (from?.url.pathname !== to?.url.pathname) {
			document.documentElement.style.scrollBehavior = 'auto';
		}
	});
	afterNavigate(() => {
		document.documentElement.style.scrollBehavior = '';
	});
	usePageTransition(() => !isChatApp);

	// Copy edit mode (dev and preview builds): every interface message editable in place. Started from
	// the account menu or `?edit-text`; the layer loads only once the mode is on.
	let copyEdit = $state<{ on: boolean } | undefined>();
	let CopyEditLayer = $state<Component | undefined>();
	onMount(() => {
		if (__COPY_EDIT__) void initCopyEdit().then((s) => (copyEdit = s));
	});
	$effect(() => {
		if (copyEdit?.on && !CopyEditLayer) void loadCopyEditLayer().then((c) => (CopyEditLayer = c));
	});

	const path = $derived(unlocalizedPath(page.url.pathname));
	// WordPress-style page hook class for per-page CSS overrides — `page-home`,
	// `page-map-methodology`, `update-my-post`, etc. Prefix comes from the loaded doc's own
	// `collection` (each `+page.server.ts` load tags its return value — see
	// `[...slug]/+page.server.ts` / root `+page.server.ts`), not the URL, since a route path
	// and its collection name aren't guaranteed to match. Falls back to `page` for routes with
	// no `collection` in their load data.
	const collection = $derived(
		'collection' in page.data && page.data.collection === 'updates' ? 'update' : 'page'
	);
	// The URL is only the slug source for `page` docs; `update` docs live under `/updates/...`,
	// so that segment is stripped before it's used as the class suffix.
	const docSlug = $derived.by(() => {
		if (path === '/') return 'home';
		const trimmed = path.replace(/^\/|\/$/g, '');
		const stripped =
			collection === 'update' && trimmed.startsWith('updates/')
				? trimmed.slice('updates/'.length)
				: trimmed;
		return stripped.replace(/\//g, '-');
	});
	// Payload's `template` select only exists on `pages` loads (see [...slug]/+page.server.ts /
	// root +page.server.ts) — updates never set it, so this naturally stays undefined for them.
	const template = $derived('template' in page.data ? page.data.template : undefined);
	// `isHome` only exists on the root route's load (see +page.server.ts) — it's a real flag off
	// the loaded doc rather than inferring "home" from the URL/slug like docSlug does, so a page
	// literally slugged "home" can't be confused with the actual isHome-flagged Payload doc.
	const isHome = $derived('isHome' in page.data && page.data.isHome === true);
	// The gap map's org and product pages are code routes, not Payload docs, so no template names them.
	const isEntity = $derived(page.route.id === '/org/[slug]' || page.route.id === '/product/[slug]');
	const bodyClass = $derived(
		[
			template ? `template-${template}` : null,
			`${collection}-${docSlug}`,
			isHome ? 'homepage' : null,
			isEntity ? 'entity-page' : null
		]
			.filter(Boolean)
			.join(' ')
	);

	const isNavigating = $derived(navigating.to != null);
	// The loading bar shows only for a navigation still loading after LOADING_BAR_DELAY ms: a quick
	// one is just the page transition ($lib/scroll/page-transition), which starts once loading ends.
	const LOADING_BAR_DELAY = 200;
	let showLoadingBar = $state(false);
	$effect(() => {
		if (!isNavigating) {
			showLoadingBar = false;
			return;
		}
		const timer = setTimeout(() => (showLoadingBar = true), LOADING_BAR_DELAY);
		return () => clearTimeout(timer);
	});

	// The Alpha chat is a full-page app, not a page inside the Potluck site: the dedicated /chat/*
	// tree renders without the site header and footer. (The /alpha landing page embeds the same app
	// inside the site, and keeps the chrome.)
	const isChatApp = $derived(
		page.route.id?.startsWith('/chat') === true || page.route.id === '/alpha/demo'
	);
</script>

<svelte:head>
	<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href={jakartaLatin} />
	<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href={notoSerifLatin} />
	<!-- Chat never renders the site header or any icon-font glyph; an unused preload only warns there. -->
	{#if !isChatApp}
		<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href={iconFontUrl} />
	{/if}
</svelte:head>

{#if showLoadingBar}
	<div
		class="fixed inset-x-0 top-0 z-60 h-1 origin-left animate-pulse bg-salmon"
		role="progressbar"
		aria-label="Loading page"
	></div>
{/if}

{#if isChatApp}
	<div class="{bodyClass} relative flex h-dvh flex-col overflow-hidden">
		{@render children()}
	</div>
{:else if SiteChrome}
	<!-- The website's header, footer and scroll wrapper (lib/website/SiteChrome.svelte). The public
	     snapshot has no website, so it falls through to the bare page below. -->
	<SiteChrome {data} {bodyClass}>
		{@render children()}
	</SiteChrome>
{:else}
	<div class="{bodyClass} relative flex min-h-dvh flex-col overflow-x-clip">
		{@render children()}
	</div>
{/if}

{#if copyEdit?.on && CopyEditLayer}
	<CopyEditLayer />
{/if}
