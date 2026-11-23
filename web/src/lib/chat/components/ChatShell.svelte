<script lang="ts">
	import '../../../styles/main.css';

	import { onDestroy, onMount, untrack } from 'svelte';
	import BrowserChromeSync from './BrowserChromeSync.svelte';
	import { goto, afterNavigate, invalidateAll, preloadData } from '$app/navigation';
	import { base, CHAT_HOST } from '$lib/chat/paths';
	import { DEPLOYMENT } from '$lib/deployment';
	import { page } from '$app/state';
	import { SHARE_TAGLINE, SHARE_TEXT, SHARE_IMAGE } from '$lib/chat/constants/share';
	import { APP_NAME } from '$lib/chat/constants/app';
	import { initAnalytics, trackEvent, markInternalIfNeeded } from '$lib/analytics';
	import { browser } from '$app/env';

	import { ERROR_MESSAGES, error, errorHeld, isRateLimitMessage } from '$lib/chat/stores/errors';
	import { createSettingsStore } from '$lib/chat/stores/settings';
	import { applyServerDefault as applyAgentModeServerDefault } from '$lib/chat/stores/agentMode';
	import { setHapticsEnabled } from '$lib/chat/utils/haptics';

	import ChatAppLayout from '$lib/chat/components/ChatAppLayout.svelte';
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import MaintenanceBanner from '$lib/chat/components/MaintenanceBanner.svelte';
	import StatusBanner from '$lib/chat/components/StatusBanner.svelte';
	import {
		CHAT_WINDOW_DEFAULT_MODE,
		CHAT_MODE_STORAGE_KEY,
		CHAT_THEME_STORAGE_KEY,
		CHAT_CUSTOM_THEME_STORAGE_KEY
	} from '$lib/chat/chatTheme';
	import DeleteAllConversationsModal from '$lib/chat/components/DeleteAllConversationsModal.svelte';
	import { deleteAllMode, deleteAllOpen, wipeCommitted, wipeInProgress, wipedThisSession } from '$lib/chat/stores/deleteAll';
	import { settingsReturnTo } from '$lib/chat/settingsSections';
	import { setContext } from 'svelte';
	import { ApiError, apiErrorMessage, handleResponse, useAPIClient } from '$lib/chat/APIClient';
	import { isAborted } from '$lib/chat/stores/isAborted';
	import { isPro } from '$lib/chat/stores/isPro';
	import BackgroundGenerationPoller from '$lib/chat/components/BackgroundGenerationPoller.svelte';
	import HistoryKeyGate from '$lib/chat/components/historyKey/HistoryKeyGate.svelte';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { createConversationsStore } from '$lib/chat/stores/conversations.svelte';
	import type { WipeSummary } from '$lib/chat/types/WipeSummary';
	import { createSessionFootprintStore } from '$lib/chat/stores/sessionFootprint.svelte';
	import { getConfigManager } from '$lib/chat/utils/PublicConfig.svelte';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
	import { shownThreadTitle } from '$lib/chat/crypto/shownTitle.svelte';
	import type { SealedState } from '$lib/chat/crypto/sealedShape';
	import { isChatModelsRoute, isSharedConversationRoute } from '$lib/chat/utils/chatRoutes';

	let {
		data = $bindable(),
		children,
		hasPageSeo = false
	} = $props();

	const publicConfig = getConfigManager(data.publicConfig);

	setContext('publicConfig', publicConfig);
	const client = useAPIClient();

	const SESSION_STARTED_KEY = 'ap:sessionStarted';

	// afterNavigate also fires once on initial mount, so this inits the client and fires
	// session_started — no separate onMount needed. ($pageview/$pageleave are captured site-wide by
	// the root layout; chat only adds its own events here.)
	afterNavigate(({ to }) => {
		initAnalytics(
			publicConfig.PUBLIC_POSTHOG_KEY,
			publicConfig.PUBLIC_POSTHOG_HOST,
			undefined,
			publicConfig.PUBLIC_POSTHOG_LEGACY_KEY
		);
		// Checked every navigation (not just once) so a mid-session ?ph_test=1 still lands.
		markInternalIfNeeded();

		// PostHog spec's session_started: once per browser tab session (sessionStorage,
		// not per-navigation), so a user bouncing between routes doesn't inflate the count.
		if (browser && !sessionStorage.getItem(SESSION_STARTED_KEY)) {
			sessionStorage.setItem(SESSION_STARTED_KEY, '1');
			const url = to?.url ?? page.url;
			trackEvent('session_started', {
				source: url.searchParams.get('ref') ?? url.searchParams.get('utm_source') ?? 'direct',
				logged_in: !!page.data.user
			});
		}
	});

	// Session footprint (time-here + estimated energy). Created once here so both the
	// footprint chrome and the conversation page (which records responses) share it.
	const footprintStore = createSessionFootprintStore();

	const convsStore = createConversationsStore();

	function isConversationPromise(
		value: ConvSidebar[] | Promise<ConvSidebar[]>
	): value is Promise<ConvSidebar[]> {
		return value != null && typeof (value as Promise<ConvSidebar[]>).then === 'function';
	}

	// Seed empty for SSR/first paint; streamed conversations patch in when the promise resolves.
	convsStore.init([]);
	let conversationsLoading = $state(isConversationPromise(data.conversations));

	// The skeleton is for the first load only. A later refresh (an invalidation after a delete, say)
	// keeps the list already on screen until the new one lands, rather than flashing the rail back to
	// its loading state mid-conversation.
	let conversationsLoadedOnce = false;
	$effect(() => {
		const value = data.conversations;
		if (isConversationPromise(value)) {
			if (!conversationsLoadedOnce) conversationsLoading = true;
			void value.then((list) => {
				conversationsLoadedOnce = true;
				conversationsLoading = false;
				convsStore.init(list, { keepPrepended: true });
			});
			return;
		}
		conversationsLoadedOnce = true;
		conversationsLoading = false;
		convsStore.init(value ?? [], { keepPrepended: true });
	});

	// Chat-app layout: sidebar expanded by default on desktop; user can collapse to icon rail.
	let isNavCollapsed = $state(false);
	// Theme (seed set) for the window; the ThemeProvider restores a persisted choice itself.
	let chatTheme = $state('alpha');

	// No collapse on navigation: the design system's sidebar is
	// persistent and pushes the page aside rather than covering it, and the phone drawer closes itself on
	// navigation (ChatAppLayout). Collapsing here would fold the desktop sidebar on every send.

	let errorToastTimeout: ReturnType<typeof setTimeout>;
	let currentError: string | undefined = $state();

	async function onError() {
		// "Forget everything" pressed mid-answer ends that answer's stream from the server
		// side, and the conversation page reads the cut as a dropped connection. Toasting it would put "The
		// connection dropped before a reply arrived. Please try again." beside the receipt saying the
		// conversation was deleted. Nothing is left to retry, and a failed wipe reports itself in the
		// modal's own error phase, so no toast is owed while a wipe is running or just committed.
		if ($wipeInProgress || $wipeCommitted) {
			$error = undefined;
			return;
		}
		// If a new different error comes, wait for the current error to hide first
		if ($error && currentError && $error !== currentError) {
			clearTimeout(errorToastTimeout);
			currentError = undefined;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}

		currentError = $error;

		// A rate-limit / cap stop is a STATE the user needs to read and act on (wait, or start a new
		// chat), not a transient blip — keep it up far longer than an ordinary error so a 5-second
		// flash can't be missed. (The Toast has no dismiss control, so we still auto-clear eventually.)
		// A send the server refused before streaming is the same kind of state.
		const isLimit = isRateLimitMessage($error) || $errorHeld;
		errorToastTimeout = setTimeout(
			() => {
				$error = undefined;
				$errorHeld = false;
				currentError = undefined;
			},
			isLimit ? 20000 : 5000
		);
	}

	async function deleteConversation(id: string) {
		// The landing page's data loads while the DELETE runs, and the rail row
		// goes only once the page has left, so the two leave together however slow the navigation is.
		if (page.params.id === id) preloadData(`${base}/`).catch(() => {});
		const leave = async () => {
			if (page.params.id === id) {
				try {
					await goto(`${base}/`);
				} finally {
					convsStore.remove(id);
				}
				void invalidateAll();
			} else convsStore.remove(id);
		};
		client
			.conversations({ id })
			.delete()
			.then(handleResponse)
			.then(leave)
			.catch(async (err) => {
				// A 404 means the chat is already gone (deleted in another tab, or a second click
				// on a slow delete), which is what the person asked for, so the row leaves quietly.
				if (isGone(err)) return leave();
				console.error(err);
				// A 502 or 503 carries the server's own line (storage busy, or files kept), which says
				// why the chat is still here; anything else gets the generic one.
				const fallback = "Couldn't delete that conversation. Please try again.";
				$error = isStorageRefusal(err) ? apiErrorMessage(err, fallback) : fallback;
			});
	}

	const isGone = (err: unknown) => err instanceof ApiError && err.status === 404;
	const isStorageRefusal = (err: unknown) => err instanceof ApiError && (err.status === 502 || err.status === 503);

	// optimistic, so the rail and header change at once; a failed PATCH puts the old title back.
	// A person's own title has no titleSource, which the auto-title markers would otherwise describe.
	async function renameConversation(id: string, title: string) {
		const before = convsStore.list.find((c) => String(c.id) === id);
		convsStore.update(id, { title, titleSource: undefined });
		try {
			await client.conversations({ id }).patch({ title }).then(handleResponse);
		} catch (err) {
			// A chat deleted elsewhere can't be renamed, so its row leaves the rail too.
			if (isGone(err)) {
				convsStore.remove(id);
				$error = 'That conversation no longer exists.';
				return;
			}
			if (before) convsStore.update(id, { title: before.title, titleSource: before.titleSource });
			console.error(err);
			$error = "Couldn't rename that conversation. Please try again.";
		}
	}

	// Pin is optimistic like rename: the rail changes at once, a failed PATCH puts it back. Archive
	// waits for its PATCH (below). A pin moves the row into the Pinned section without touching its date.
	async function pinConversation(id: string, pinned: boolean) {
		convsStore.update(id, { pinned });
		try {
			await client.conversations({ id }).patch({ pinned }).then(handleResponse);
		} catch (err) {
			if (isGone(err)) {
				convsStore.remove(id);
				$error = 'That conversation no longer exists.';
				return;
			}
			convsStore.update(id, { pinned: !pinned });
			console.error(err);
			$error = "Couldn't update that pin. Please try again.";
		}
	}

	// Tags wait for their PATCH: the server turns the typed names into ids, and the rail shows what it
	// stored. Resolves true when they were saved, so the sidebar can refresh its filter row.
	async function tagConversation(id: string, names: string[]): Promise<boolean> {
		try {
			const res = (await client.conversations({ id }).patch({ tags: names }).then(handleResponse)) as {
				tags?: { id: string }[];
			} | null;
			convsStore.update(id, { tags: (res?.tags ?? []).map((t) => t.id) });
			return true;
		} catch (err) {
			if (isGone(err)) {
				convsStore.remove(id);
				$error = 'That conversation no longer exists.';
				return false;
			}
			console.error(err);
			$error = "Couldn't save those tags. Please try again.";
			return false;
		}
	}

	// Archiving takes the chat out of the rail; it stays under Settings → Archived chats. Archiving the
	// chat on screen leaves it for the new-chat page, as deleting does.
	async function archiveConversation(id: string) {
		const leaving = page.params.id === id;
		try {
			await client.conversations({ id }).patch({ archived: true }).then(handleResponse);
		} catch (err) {
			if (isGone(err)) {
				convsStore.remove(id);
				$error = 'That conversation no longer exists.';
				return;
			}
			console.error(err);
			$error = "Couldn't archive that conversation. Please try again.";
			return;
		}
		if (leaving) await goto(`${base}/`);
		convsStore.remove(id);
	}

	// Trash-all is the GDPR wipe: returns the summary of what was cleared so the modal can show the
	// reassurance panel. The store reset + navigation are deferred to onWipeDismissed (below) so the
	// summary stays on screen until the user dismisses it — navigating with invalidateAll here would
	// tear the panel down before they read it.
	async function deleteAllConversations(mode: 'data' | 'account'): Promise<WipeSummary> {
		// Raised before the request goes out, because the conversation stops existing the moment the
		// server commits and a background resync landing in that window redirects away from the panel
		// the visitor is about to read. Waiting for the response would leave that window
		// open. Lowered in `onclose`, which runs on every dismissal path including the error one.
		wipeInProgress.set(true);
		try {
			const summary = (await client.conversations
				.delete(mode === 'account' ? { query: { account: 'delete' } } : undefined)
				.then(handleResponse)) as WipeSummary;
			wipeCommitted.set(true);
			return summary;
		} catch (err) {
			console.error(err);
			$error = String(err);
			throw err; // surface to the modal's error state
		}
	}

	async function onWipeDismissed() {
		convsStore.init([]);
		wipedThisSession.set(true);
		// Reset the ambient session footprint too, so a "clear everything" visibly clears the
		// corner timer + energy as well. Cosmetic (it's client-only), just a consistent reset.
		footprintStore.reset();
		// "Forget everything" from a settings page stays there. The person is looking at the
		// usage panel, which has just reloaded to zero, and sending them to a new chat took
		// that away. The navigation home exists for a wipe started from a conversation, whose page has
		// just been deleted, and for "Delete account", which leaves no account settings to stay on.
		// Staying still reloads every load function, as the navigation did, so nothing on screen keeps
		// pre-wipe data; "Back to app" goes home, since the chat it remembered is gone.
		// eslint-disable-next-line chat-paths/no-chat-path-literal -- a route id, `/chat` on both surfaces
		if ($deleteAllMode === 'data' && page.route.id?.startsWith('/chat/settings')) {
			settingsReturnTo.set(`${base}/`);
			await invalidateAll();
			wipeCommitted.set(false);
			return;
		}
		await goto(`${base}/`, { invalidateAll: true });
		wipeCommitted.set(false);
	}

	onDestroy(() => {
		clearTimeout(errorToastTimeout);
	});

	// The toast shows `currentError`, a copy of `$error`, so clearing the store alone would leave it up for the
	// rest of its 20 s hold, over the answer that follows a held refusal cleared by the next send or a
	// successful create.
	$effect(() => {
		if ($error) onError();
		else if (untrack(() => currentError)) {
			clearTimeout(errorToastTimeout);
			currentError = undefined;
		}
	});

	const settings = createSettingsStore(data.settings);

	$effect(() => {
		setHapticsEnabled($settings.hapticsEnabled);
	});

	// Global keyboard shortcut: New Chat (Ctrl/Cmd + Shift + O). Its own synchronous onMount, because a
	// lifecycle call after the async one's awaits throws lifecycle_outside_component.
	onMount(() => {
		const onKeydown = (e: KeyboardEvent) => {
			// Ignore when a modal has focus (app is inert)
			const appEl = document.getElementById('app');
			if (appEl?.hasAttribute('inert')) return;

			const oPressed = e.key?.toLowerCase() === 'o';
			const metaOrCtrl = e.metaKey || e.ctrlKey;
			if (oPressed && e.shiftKey && metaOrCtrl) {
				e.preventDefault();
				isAborted.set(true);
				if (requireAuthUser()) return;
				goto(`${base}/`, { invalidateAll: true });
			}
		};

		window.addEventListener('keydown', onKeydown, { capture: true });
		return () => window.removeEventListener('keydown', onKeydown, { capture: true });
	});

	onMount(async () => {
		applyAgentModeServerDefault(data.agentModeDefault);

		if (publicConfig.isHuggingChat && data.user?.username) {
			fetch(`https://huggingface.co/api/users/${data.user.username}/overview`)
				.then((res) => res.json())
				.then((userData) => {
					isPro.set(userData.isPro ?? false);
				})
				.catch(() => {
					// Keep isPro as null on error - don't show any badge if status is unknown
				});
		}

		// `base` ("/chat") is the right landing target for the DEDICATED /chat/* route tree — its own
		// nested routes (conversation/[id], settings, models, ...) still want to land back on the chat
		// root after handling ?model=/?token=, not wherever the current path happens to be. Only
		// routes/chat/+layout.svelte mounts this shell now (the /alpha demo that mounted it elsewhere is
		// retired), so the current-path fallback is a safe default for a page outside that tree, which
		// would otherwise be bounced to /chat/. `page.route.id` is the route FILE pattern, not the URL.
		// eslint-disable-next-line chat-paths/no-chat-path-literal -- a route id, `/chat` on both surfaces
		const chatRootPath = page.route.id?.startsWith('/chat') ? `${base}/` : page.url.pathname;

		if (page.url.searchParams.has('model')) {
			await settings
				.instantSet({
					activeModel: page.url.searchParams.get('model') ?? $settings.activeModel
				})
				.then(async () => {
					// Transient copy, mutated then handed to goto(); never read as state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const query = new URLSearchParams(page.url.searchParams.toString());
					query.delete('model');
					await goto(`${chatRootPath}?${query.toString()}`, {
						invalidateAll: true
					});
				});
		}

		// A direct load of a conversation this session can't open redirects here with
		// ?unavailable=1 (conversation/[id]/+page.ts), since the server's store can't carry the toast.
		if (page.url.searchParams.has('unavailable')) {
			$error = ERROR_MESSAGES.conversationUnavailable;
			// Transient copy, mutated then handed to goto(); never read as state.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const query = new URLSearchParams(page.url.searchParams.toString());
			query.delete('unavailable');
			const rest = query.toString();
			await goto(rest ? `${chatRootPath}?${rest}` : chatRootPath, { replaceState: true });
		}

		if (page.url.searchParams.has('token')) {
			const token = page.url.searchParams.get('token');

			await fetch(`${base}/api/user/validate-token`, {
				method: 'POST',
				body: JSON.stringify({ token })
			}).then(() => {
				goto(chatRootPath, { invalidateAll: true });
			});
		}

	});

	let listedConv = $derived(convsStore.list.find((conv) => conv.id === page.params.id));

	// The open conversation for ChatWindow's ThreadHeader (title + title-menu actions). Context, not
	// props: ChatWindow is also mounted by routes that never see the sidebar store.
	setContext('alpha:thread-title', {
		get title() {
			// The rail's list is streamed in after first paint, so on a full page load (sign-in return, a
			// reload, a link) it has no row yet; the conversation page's own load already has the title.
			// Either may be sealed, so both go through shownTitle, never a bare `.title`.
			const loaded = page.data as { id?: string; title?: string; titleState?: SealedState };
			const thisChat = page.params.id && loaded.id === page.params.id ? { ...loaded, id: page.params.id } : undefined;
			return shownThreadTitle(listedConv, thisChat) ?? '';
		},
		/** Delete the open conversation (title menu → Delete). Absent when there's nothing to delete. */
		get deleteCurrent() {
			if (!page.params.id) return undefined;
			return () => deleteConversation(page.params.id as string);
		},
		/** Rename the open conversation (title menu → Rename). Absent like deleteCurrent. */
		get renameCurrent() {
			if (!page.params.id) return undefined;
			return (title: string) => renameConversation(page.params.id as string, title);
		}
	});

	// The read-only share-link viewer carries no app-wide social card.
	let isSharedConversationView = $derived(isSharedConversationRoute(page.route.id));
	// On chat's own host the canonical URL is that host; www/chat only redirects here.
	const chatOrigin = $derived(
		page.url.hostname === CHAT_HOST ? page.url.origin : publicConfig.PUBLIC_ORIGIN || page.url.origin
	);
	let appName = APP_NAME;

	// Split so the literal substring can't be mistaken for a real tag by tooling that scans raw
	// source text for it (the svelte/eslint parsers both do, even inside a JS string) — see
	// Seo.svelte's identical pattern.
	const chatJsonLdOpen = '<' + 'script type="application/ld+json">';
	const chatJsonLdClose = '<' + '/script>';
	const chatJsonLdMarkup = $derived(
		JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'WebSite',
			name: appName,
			description: SHARE_TEXT,
			url: `${chatOrigin}${base}`
		}).replace(/</g, '\\u003c')
	);

	// Org identity: the Organization is the installation's publisher (src/lib/deployment.ts), whose
	// address and contact points are the ones its published privacy notice states (never invent org
	// facts here). WebApplication is the chat product itself, publisher-linked to the Organization, so
	// an agent can resolve both "who runs this" and "what is this" from one script tag. An installation
	// with no publisher states the WebApplication alone. Kept as its own graph (rather than folded into
	// chatJsonLdMarkup's WebSite entry above) since it's a distinct schema addition.
	const publisher = DEPLOYMENT.publisher;
	const publisherId = publisher ? `${publisher.url}/#organization` : null;
	const orgJsonLdMarkup = $derived(
		JSON.stringify({
			'@context': 'https://schema.org',
			'@graph': [
				...(publisher && publisherId
					? [
							{
								'@type': 'Organization',
								'@id': publisherId,
								name: publisher.name,
								url: publisher.url,
								...(publisher.email ? { email: publisher.email } : {}),
								...(publisher.address
									? { address: { '@type': 'PostalAddress', ...publisher.address } }
									: {}),
								...(publisher.contactPoints?.length
									? {
											contactPoint: publisher.contactPoints.map((point) => ({
												'@type': 'ContactPoint',
												...point
											}))
										}
									: {})
							}
						]
					: []),
				{
					'@type': 'WebApplication',
					'@id': `${chatOrigin}${base}/#software`,
					name: appName,
					url: `${chatOrigin}${base}`,
					description: publicConfig.PUBLIC_APP_DESCRIPTION,
					applicationCategory: 'AI Chat Application',
					operatingSystem: 'Any (web-based)',
					isAccessibleForFree: true,
					...(publisherId ? { publisher: { '@id': publisherId } } : {})
				}
			]
		}).replace(/</g, '\\u003c')
	);
</script>

<svelte:head>
	<!-- hasPageSeo: the /chat landing page (routes/chat/+page.svelte) renders its own <Seo> from the
	     Payload-authored page.meta and passes this to skip the page-specific tags below — everything
	     else here (favicons, manifest, org identity, Plausible) stays app-wide regardless. -->
	{#if !hasPageSeo}
		<title>{appName} — {SHARE_TAGLINE}</title>
		<meta name="description" content={publicConfig.PUBLIC_APP_DESCRIPTION} />
		<!-- Same granularity as og:url below, deliberately: chat routes beyond the landing page are
		     conversations, not indexable content, so canonical points at the app root rather than a
		     per-conversation path. -->
		<link rel="canonical" href="{chatOrigin}{base}" />
	{/if}

	<!-- Social card. The title/description/image are AI-Potluck-specific constants (share.ts) —
	     NOT the upstream chat-ui defaults — so a shared link previews as AI Potluck regardless
	     of how PUBLIC_APP_DESCRIPTION is set in the deploy env. Image is the editorial OG card in
	     static/. Shown everywhere except a model's own page, which sets its own page-specific
	     og:title/og:url in routes/chat/models/[...model]/+page.svelte that this would otherwise
	     duplicate/contradict (this component's og:url always points at the app root).
	     isChatModelsRoute checks `page.route.id`, the route FILE pattern, the same way `chatRootPath`
	     above distinguishes the dedicated /chat/* tree from the CMS catch-all. -->
	{#if !isChatModelsRoute(page.route.id) && !isSharedConversationView}
		{#if !hasPageSeo}
			<meta name="twitter:card" content="summary_large_image" />
			<meta name="twitter:title" content="{appName} — {SHARE_TAGLINE}" />
			<meta name="twitter:description" content={SHARE_TEXT} />
			<meta
				name="twitter:image"
				content="{chatOrigin}{base}{SHARE_IMAGE}"
			/>
			<meta name="twitter:image:alt" content="{appName} — {SHARE_TAGLINE}" />
			<meta property="og:title" content="{appName} — {SHARE_TAGLINE}" />
			<meta property="og:type" content="website" />
			<meta property="og:url" content="{chatOrigin}{base}" />
			<meta
				property="og:image"
				content="{chatOrigin}{base}{SHARE_IMAGE}"
			/>
			<meta property="og:description" content={SHARE_TEXT} />
			<meta property="og:site_name" content={appName} />
			<meta property="og:locale" content="en_US" />
			<!-- chatJsonLdMarkup is JSON.stringify output with `<` escaped, not user input; @html is
			     needed here to emit a real script element. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html `${chatJsonLdOpen}${chatJsonLdMarkup}${chatJsonLdClose}`}
		{/if}
		<!-- orgJsonLdMarkup is static org facts + app constants, never user input, JSON < -escaped
		     above; @html is needed here to emit a real script element. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html `${chatJsonLdOpen}${orgJsonLdMarkup}${chatJsonLdClose}`}
	{/if}
	<link rel="icon" href="{publicConfig.assetPath}/icon.svg" type="image/svg+xml" />
	{#if publicConfig.PUBLIC_ORIGIN}
		<link
			rel="icon"
			href="{publicConfig.assetPath}/favicon.svg"
			type="image/svg+xml"
			media="(prefers-color-scheme: light)"
		/>
		<link
			rel="icon"
			href="{publicConfig.assetPath}/favicon-dark.svg"
			type="image/svg+xml"
			media="(prefers-color-scheme: dark)"
		/>
	{:else}
		<link rel="icon" href="{publicConfig.assetPath}/favicon-dev.svg" type="image/svg+xml" />
	{/if}
	<link rel="apple-touch-icon" href="{publicConfig.assetPath}/apple-touch-icon.png" />
	<!-- the installed app opens chat's home, `/chat` here or `/` on the chat surface. -->
	<link rel="manifest" href="{publicConfig.assetPath}/{base ? 'manifest.json' : 'manifest-root.json'}" />

	{#if publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}
		<script async src={publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}></script>
	{/if}

	{#if publicConfig.PUBLIC_APPLE_APP_ID}
		<meta name="apple-itunes-app" content={`app-id=${publicConfig.PUBLIC_APPLE_APP_ID}`} />
	{/if}
</svelte:head>

<BackgroundGenerationPoller />

{#snippet appBody()}
	<MaintenanceBanner banner={data.maintenanceBanner} />
	<StatusBanner />
	<div class="relative min-h-0 flex-1">
		<ChatAppLayout
			conversations={convsStore.list}
			{conversationsLoading}
			bind:isNavCollapsed
			ondeleteConversation={(id) => deleteConversation(id)}
			onrenameConversation={(id, title) => renameConversation(id, title)}
			onpinConversation={(id, pinned) => pinConversation(id, pinned)}
			onarchiveConversation={(id) => archiveConversation(id)}
			ontagConversation={(id, names) => tagConversation(id, names)}
			{currentError}
		>
			{@render children?.()}
		</ChatAppLayout>
	</div>
	<!-- Inside the ThemeProvider so its portal carries the window's theme and mode. -->
	{#if $deleteAllOpen}
		<DeleteAllConversationsModal
			open={$deleteAllOpen}
			onclose={() => {
				deleteAllOpen.set(false);
				wipeInProgress.set(false);
			}}
			mode={$deleteAllMode}
			ondelete={() => deleteAllConversations($deleteAllMode)}
			onfinish={onWipeDismissed}
		/>
	{/if}
	<!-- The history key's recovery step and unlock prompt; nothing while its flag is off. -->
	<HistoryKeyGate />
{/snippet}

<!-- /chat: a full-page app (no Potluck site chrome — see routes/+layout.svelte). The design-system
     scope (tokens, theme, mode) covers the whole viewport. -->
<ThemeProvider
	mode={CHAT_WINDOW_DEFAULT_MODE}
	persist={CHAT_MODE_STORAGE_KEY}
	bind:theme={chatTheme}
	persistTheme={CHAT_THEME_STORAGE_KEY}
	persistCustom={CHAT_CUSTOM_THEME_STORAGE_KEY}
	class="chat-window flex h-dvh min-h-0 w-full flex-col"
>
	<BrowserChromeSync />
	{@render appBody()}
</ThemeProvider>

{#if publicConfig.PUBLIC_PLAUSIBLE_SCRIPT_URL}
	<script>
		((window.plausible =
			window.plausible ||
			function () {
				(plausible.q = plausible.q || []).push(arguments);
			}),
			(plausible.init =
				plausible.init ||
				function (i) {
					plausible.o = i || {};
				}));
		plausible.init();
	</script>
{/if}


