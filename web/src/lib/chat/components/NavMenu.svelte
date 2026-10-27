<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { base } from '$lib/chat/paths';
	import { goto } from '$app/navigation';
	import { page, navigating } from '$app/state';

	import RiChatNewLine from '~icons/ri/chat-new-line';
	import RiSearchLine from '~icons/ri/search-line';
	import RiFolder3Line from '~icons/ri/folder-3-line';
	import RiArrowLeftLine from '~icons/ri/arrow-left-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import {
		groupSettingsSections,
		settingsNavInputs,
		settingsReturnTo,
		settingsExternalLinks,
		settingsSections
	} from '$lib/chat/settingsSections';
	import { isAborted } from '$lib/chat/stores/isAborted';
	import { newChatRequests } from '$lib/chat/stores/newChat';
	import { ERROR_MESSAGES, error } from '$lib/chat/stores/errors';

	import NavConversationItem from './NavConversationItem.svelte';
	import NavConversationsSkeleton from './NavConversationsSkeleton.svelte';
	import AccountMenu from './AccountMenu.svelte';
	import TourHint from './TourHint.svelte';
	import GetInvolvedCard from './GetInvolvedCard.svelte';
	import PotluckMark from './PotluckMark.svelte';
	import ChatSearchDialog from './ChatSearchDialog.svelte';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
	import InfiniteScroll from './InfiniteScroll.svelte';
	import { CONV_NUM_PER_PAGE } from '$lib/chat/constants/pagination';
	import { useAPIClient, handleResponse } from '$lib/chat/APIClient';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { authClient } from '$lib/chat/authClient';
	import { Badge, Kbd, Sidebar } from '@aipotluck/alpha-ds';
	const localizedTitles = $derived({ today: m.product_today(), yesterday: m.product_yesterday(), lastWeek: m.product_lastWeek(), lastMonth: m.product_lastMonth(), older: m.product_older() });
	const client = useAPIClient();

	interface Props {
		conversations: ConvSidebar[];
		p?: number;
		/** Sidebar history is still streaming from the layout load. */
		loading?: boolean;
		ondeleteConversation?: (id: string) => void;
		onrenameConversation?: (id: string, title: string) => void;
		embeddedDemo?: boolean;
		embeddedActiveConversationId?: string;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	}

	let {
		conversations = $bindable(),
		p = $bindable(0),
		loading = false,
		ondeleteConversation,
		onrenameConversation,
		embeddedDemo = false,
		embeddedActiveConversationId,
		onEmbeddedNavigate
	}: Props = $props();

	let hasMore = $state(true);

	let searchOpen = $state(false);

	// Settings is a state of the app: while a settings route is open, the sidebar's
	// content becomes "Back to app" and the section list, instead of a modal over the chat.
	const inSettings = $derived(!embeddedDemo && page.url.pathname.startsWith(`${base}/settings`));
	const sections = $derived(
		inSettings
			? settingsSections({
					base,
					path: page.url.pathname,
					...settingsNavInputs(page.data)
				})
			: []
	);

	function handleNewChatClick(e: MouseEvent) {
		isAborted.set(true);

		if (embeddedDemo) {
			e.preventDefault();
			onEmbeddedNavigate?.({ kind: 'new-chat' });
			return;
		}

		if (requireAuthUser()) {
			e.preventDefault();
			return;
		}

		e.preventDefault();

		// Ignore impatient repeat clicks while a nav is already in flight. Without this,
		// each click stacks another full navigation, and "new chat" feels slow enough that users click
		// repeatedly.
		if (navigating.to) return;

		// The empty composer's attachments and draft belong to the chat being left, including
		// when this click navigates nowhere because the empty composer is already showing. (CUR-3052)
		newChatRequests.update((n) => n + 1);

		// Already on the empty composer? Then this IS a new chat — no-op instead of reloading.
		const here = page.url.pathname.replace(/\/+$/, '');
		const home = base.replace(/\/+$/, '');
		if (here === home) return;

		// Plain client-side nav to the empty composer. No invalidateAll: starting a new chat
		// creates/deletes nothing, so re-running every load (conversations + settings + flags)
		// only added seconds. The sidebar store already reflects state client-side; the
		// Delete-all flow has its own refresh path.
		goto(`${base}/`);
	}

	// signed-in state can come from EITHER auth system today — Better Auth's bridge branch in
	// authenticateRequest (auth.ts) derives sessionId/secretSessionId from Better Auth's OWN session
	// token, never touching the legacy `sessions` doc-store collection at all, so the old POST /logout
	// route (which only clears that collection + the legacy cookie) would silently leave a Better Auth
	// session cookie valid — a logout that appears to work and then reverses itself on the next request.
	// Calling both is the only way to be correct regardless of which system authenticated this visitor;
	// each is a no-op (not an error) when its own session doesn't exist. (CUR-432)
	let loggingOut = $state(false);
	async function handleLogout() {
		if (embeddedDemo) {
			onEmbeddedNavigate?.({ kind: 'app', label: 'Accounts' });
			return;
		}
		if (loggingOut) return;
		loggingOut = true;
		// Better Auth's client reports a refused sign-out as `{ error }` rather than throwing,
		// and answers success when there is no session to end. An error therefore means the session is
		// still live, and reloading would land the person back in it as if Log out had worked. (CUR-3931)
		const result = await authClient.signOut().catch((e: unknown) => ({ error: e }));
		await fetch(`${base}/logout`, { method: 'POST' }).catch(() => undefined);
		if (result?.error) {
			loggingOut = false;
			error.set(ERROR_MESSAGES.signOutRefused);
			return;
		}
		// Deliberately a hard navigation, not goto()+invalidateAll(). ChatShell's `settings`
		// context store (settings.ts's createSettingsStore) is seeded ONCE from layout data at
		// component init and has no $effect resyncing it when `data` changes — unlike convsStore,
		// which does (ChatShell.svelte's own $effect on data.conversations). invalidateAll() would
		// correctly refresh page.data (so the nav's "Log in"/"Log out" state flips immediately),
		// while activeModel/customPrompts/etc. in `settings` stayed frozen at the just-logged-out
		// user's values — a stale-preference leak into the next session on the same device/tab that
		// LOOKS fixed because the visible sign-in state is correct. A full reload is the only thing
		// here that resets every client-side store at once. Don't replace this with client-side nav
		// without first giving `settings` (and anything else seeded once from layout `data`) the same
		// reactive resync convsStore already has.
		window.location.href = `${base}/`;
	}

	// Five date buckets mirroring prod groupChatsByDate (chat/components/chat/
	// sidebar-history.tsx): isToday, isYesterday, > oneWeekAgo, > oneMonthAgo, else older.
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
	// Both of these evaluate to a NUMBER (setDate/setMonth return epoch ms); the Date objects are
	// discarded on the same line and never read, let alone mutated as state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const oneWeekAgo = new Date().setDate(new Date().getDate() - 7);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const oneMonthAgo = new Date().setMonth(new Date().getMonth() - 1);

	let groupedConversations = $derived({
		today: conversations.filter(({ updatedAt }) => updatedAt.getTime() >= startOfToday),
		yesterday: conversations.filter(
			({ updatedAt }) =>
				updatedAt.getTime() >= startOfYesterday && updatedAt.getTime() < startOfToday
		),
		lastWeek: conversations.filter(
			({ updatedAt }) => updatedAt.getTime() < startOfYesterday && updatedAt.getTime() > oneWeekAgo
		),
		lastMonth: conversations.filter(
			({ updatedAt }) => updatedAt.getTime() <= oneWeekAgo && updatedAt.getTime() > oneMonthAgo
		),
		older: conversations.filter(({ updatedAt }) => updatedAt.getTime() <= oneMonthAgo)
	});

	let hasAnyConversation = $derived(conversations.length > 0);

	async function handleVisible() {
		if (embeddedDemo) {
			hasMore = false;
			return;
		}
		p++;
		const newConvs = await client.conversations
			.get({
				query: {
					p
				}
			})
			.then(handleResponse)
			.then((r) => r.conversations)
			.catch((): ConvSidebar[] => []);

		if (newConvs.length === 0) {
			hasMore = false;
			// Nothing to add, so keep reading the parent's list rather than a copy of it (CUR-2379).
			return;
		}

		conversations = [...conversations, ...newConvs];
	}

	$effect(() => {
		if (conversations.length <= CONV_NUM_PER_PAGE) {
			// reset p to 0 if there's only one page of content
			// that would be caused by a data loading invalidation
			p = 0;
		}
	});
</script>

<!-- Sidebar, composed from the design system's Sidebar pattern (inside
     AppShell.Sidebar, which owns the rail/drawer behaviour). /chat is a full-page app with no site
     header, so the brand here is the way back to AI Potluck. -->
<Sidebar.Header expandLabel={m.product_expandSidebar()} collapseLabel={m.product_collapseSidebar()} closeLabel={m.product_closeSidebar()}>
	{#snippet mark()}
		<PotluckMark class="size-5" label="AI Potluck" />
	{/snippet}
	<!-- Brand: "Alpha", with AI Potluck as the sub-brand. The glyph lines up with the row icons below
	     (16px from the edge: the rows' 8px list inset + 8px row padding; 12px + 20px icons on phones). -->
	<div class="flex min-w-0 items-center gap-2.5 pl-2 text-fg-1 max-md:gap-3 max-md:pl-3">
		<PotluckMark class="size-4 max-md:size-5" />
		<span class="truncate type-nav">Alpha</span>
		<!-- The brand itself isn't a link; the AI Potluck sub-brand is, revealing an out-arrow on hover. -->
		<a
			href="/"
			class="group/potluck flex min-w-0 items-center gap-1 type-label text-fg-3 hover:text-fg-1 focus-visible:text-fg-1"
			aria-label={m.product_home()}
			data-sidebar-home
			data-sveltekit-reload
		>
			<span class="truncate">AI Potluck</span>
			<RiArrowRightUpLine
				class="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/potluck:opacity-100 group-focus-visible/potluck:opacity-100"
				aria-hidden="true"
			/>
		</a>
	</div>
</Sidebar.Header>

{#if inSettings}
	<Sidebar.Actions>
		<Sidebar.Item
			icon={RiArrowLeftLine}
			emphasis
			href={$settingsReturnTo ?? `${base}/`}
			label={m.product_backToApp()}
			data-settings-back
		>
			{m.product_backToApp()}
		</Sidebar.Item>
	</Sidebar.Actions>
	<Sidebar.Content>
		{#each groupSettingsSections(sections) as g (g.group)}
			<Sidebar.Section label={g.label}>
				{#each g.items as section (section.label)}
					<Sidebar.Item icon={section.icon} href={section.href} current={section.current} label={section.label} aria-label={section.ariaLabel}>
						{#if section.badge}
							<span class="flex items-center justify-between gap-2">
								{section.label}
								<Badge>{section.badge}</Badge>
							</span>
						{:else}
							{section.label}
						{/if}
					</Sidebar.Item>
				{/each}
			</Sidebar.Section>
		{/each}
		<!-- Pages outside settings open in a new tab, so the settings pane stays where it was. -->
		<Sidebar.Section>
			{#each settingsExternalLinks() as link (link.href)}
				<Sidebar.Item
					icon={link.icon}
					href={link.href}
					target="_blank"
					rel="noopener"
					label={link.label}
					aria-label={m.product_opensInNewTab({ label: link.label })}
					data-settings-external
				>
					<span class="flex items-center justify-between gap-2">
						{link.label}
						<RiArrowRightUpLine aria-hidden="true" class="text-fg-3" />
					</span>
				</Sidebar.Item>
			{/each}
		</Sidebar.Section>
	</Sidebar.Content>
{:else}
<!-- The two global actions — start a chat, find a chat. -->
<Sidebar.Actions>
	<Sidebar.Item icon={RiChatNewLine} emphasis href={`${base}/`} onclick={handleNewChatClick} label={m.product_newChat()}>
		{m.product_newChat()}
	</Sidebar.Item>
	<Sidebar.Item icon={RiSearchLine} label={m.product_searchChats()} onclick={() => (searchOpen = true)}>
		<span class="flex items-center justify-between gap-2">
			{m.product_searchChats()}
			<Kbd mod>K</Kbd>
		</span>
	</Sidebar.Item>
	<!-- The sidebar nav holds your library (projects, files). Present only when the
	     per-user Files gate is on — the same gate /chat/storage enforces (CUR-1276). -->
	{#if page.data.storageViewEnabled && !embeddedDemo}
		<Sidebar.Item
			icon={RiFolder3Line}
			href={`${base}/storage`}
			current={page.url.pathname === `${base}/storage`}
			label={m.product_files()}
		>
			{m.product_files()}
		</Sidebar.Item>
	{/if}
</Sidebar.Actions>

<Sidebar.Content>
	{#if loading}
		<NavConversationsSkeleton />
	{:else if hasAnyConversation}
		{#each Object.entries(groupedConversations) as [group, convs] (group)}
			{#if convs.length}
				<Sidebar.Section label={localizedTitles[group as keyof typeof localizedTitles]}>
					{#each convs as conv (conv.id)}
						<NavConversationItem
							{conv}
							{ondeleteConversation}
							{onrenameConversation}
							{embeddedDemo}
							{embeddedActiveConversationId}
							{onEmbeddedNavigate}
						/>
					{/each}
				</Sidebar.Section>
			{/if}
		{/each}
		{#if hasMore}
			<InfiniteScroll onvisible={handleVisible} />
		{/if}
	{:else}
		<p class="px-2 pt-2 type-caption text-fg-3">
			{m.product_emptyChats()}
		</p>
	{/if}
</Sidebar.Content>
{/if}

<!-- Above the account row: the dismissible "Get involved" card (not in settings, not in the demo). -->
{#if !inSettings && !embeddedDemo}
	<GetInvolvedCard />
{/if}
<!-- Directly above the account row it points at: where the tour lives, after a skipped welcome. -->
{#if !embeddedDemo}
	<TourHint />
{/if}

<!-- One account row at the foot; settings, appearance, help, the GDPR wipe and
     sign in/out all live in its menu (AccountMenu). -->
<Sidebar.Footer>
	<AccountMenu {embeddedDemo} {onEmbeddedNavigate} onlogout={handleLogout} {loggingOut} />
</Sidebar.Footer>

<ChatSearchDialog bind:open={searchOpen} {conversations} {embeddedDemo} {onEmbeddedNavigate} />
