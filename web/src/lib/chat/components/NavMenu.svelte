<!--
SPDX-FileCopyrightText: 2018- The Hugging Face team
SPDX-License-Identifier: Apache-2.0
Modified by Current AI from huggingface/chat-ui.
-->
<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import { goto } from '$app/navigation';
	import { page, navigating } from '$app/state';
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';

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
	import { Badge, Inline, Kbd, Sidebar, Toggle } from '@aipotluck/alpha-ds';
	import type { ChatTag } from '$lib/chat/utils/chatTags';
	const localizedTitles = $derived({ today: m.product_today(), yesterday: m.product_yesterday(), lastWeek: m.product_lastWeek(), lastMonth: m.product_lastMonth(), older: m.product_older() });
	const client = useAPIClient();

	interface Props {
		conversations: ConvSidebar[];
		p?: number;
		/** Sidebar history is still streaming from the layout load. */
		loading?: boolean;
		ondeleteConversation?: (id: string) => void;
		onrenameConversation?: (id: string, title: string) => void;
		onpinConversation?: (id: string, pinned: boolean) => void;
		onarchiveConversation?: (id: string) => void;
		/** Set a chat's tags by name; true when they were saved. */
		ontagConversation?: (id: string, names: string[]) => Promise<boolean>;
	}

	let {
		conversations = $bindable(),
		p = $bindable(0),
		loading = false,
		ondeleteConversation,
		onrenameConversation,
		onpinConversation,
		onarchiveConversation,
		ontagConversation
	}: Props = $props();

	let hasMore = $state(true);

	let searchOpen = $state(false);

	// Settings is a state of the app: while a settings route is open, the sidebar's
	// content becomes "Back to app" and the section list, instead of a modal over the chat.
	const inSettings = $derived(page.url.pathname.startsWith(`${base}/settings`));
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
		// when this click navigates nowhere because the empty composer is already showing.
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
	// each is a no-op (not an error) when its own session doesn't exist.
	let loggingOut = $state(false);
	async function handleLogout() {
		if (loggingOut) return;
		loggingOut = true;
		// Better Auth's client reports a refused sign-out as `{ error }` rather than throwing,
		// and answers success when there is no session to end. An error therefore means the session is
		// still live, and reloading would land the person back in it as if Log out had worked.
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

	// Pinned chats head the list in their own section; the date groups hold the rest.
	let pinnedConversations = $derived(conversations.filter((c) => c.pinned));
	let unpinnedConversations = $derived(conversations.filter((c) => !c.pinned));

	let groupedConversations = $derived({
		today: unpinnedConversations.filter(({ updatedAt }) => updatedAt.getTime() >= startOfToday),
		yesterday: unpinnedConversations.filter(
			({ updatedAt }) =>
				updatedAt.getTime() >= startOfYesterday && updatedAt.getTime() < startOfToday
		),
		lastWeek: unpinnedConversations.filter(
			({ updatedAt }) => updatedAt.getTime() < startOfYesterday && updatedAt.getTime() > oneWeekAgo
		),
		lastMonth: unpinnedConversations.filter(
			({ updatedAt }) => updatedAt.getTime() <= oneWeekAgo && updatedAt.getTime() > oneMonthAgo
		),
		older: unpinnedConversations.filter(({ updatedAt }) => updatedAt.getTime() <= oneMonthAgo)
	});

	let hasAnyConversation = $derived(conversations.length > 0);

	async function handleVisible() {
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
			// Nothing to add, so keep reading the parent's list rather than a copy of it.
			return;
		}

		conversations = [...conversations, ...newConvs];
	}

	// ── Tags ───────────────────────────────────────────────────────────────────────────
	// A row of the person's tags heads the list; choosing one shows only the chats carrying it, read
	// from the server so a tagged chat past the loaded pages still shows. Choosing it again clears it.
	const tagsEnabled = $derived(page.data.chatTagsEnabled === true);
	let tags = $state<ChatTag[]>([]);
	let activeTag = $state<string | null>(null);
	let tagged = $state<ConvSidebar[]>([]);
	let taggedPage = 0;
	let taggedHasMore = $state(false);
	const activeTagName = $derived(tags.find((t) => t.id === activeTag)?.name ?? activeTag ?? '');

	type ListRow = { _id: { toString(): string }; title: string; updatedAt: Date | string; model?: string; pinned?: boolean; tags?: string[] };
	const toSidebar = (c: ListRow): ConvSidebar => ({
		id: c._id.toString(),
		title: c.title.trim(),
		model: c.model,
		pinned: c.pinned === true,
		tags: c.tags ?? [],
		updatedAt: new Date(c.updatedAt)
	});

	async function refreshTags() {
		try {
			const res = (await client.tags.get().then(handleResponse)) as { tags: ChatTag[] };
			tags = res.tags;
			if (activeTag && !tags.some((t) => t.id === activeTag)) activeTag = null;
		} catch {
			// Keep the row the person has; the next change asks again.
		}
	}

	$effect(() => {
		if (browser && tagsEnabled) untrack(() => void refreshTags());
	});

	async function loadTagged(tag: string, from: number) {
		const res = (await client.conversations.get({ query: { p: from, tag } }).then(handleResponse)) as {
			conversations: ListRow[];
			hasMore: boolean;
		};
		if (activeTag !== tag) return;
		const rows = res.conversations.map(toSidebar);
		tagged = from === 0 ? rows : [...tagged, ...rows];
		taggedPage = from;
		taggedHasMore = res.hasMore;
	}

	// InfiniteScroll calls again every 250 ms while it is in view, so one page is asked for at a time.
	let taggedLoading = false;
	async function moreTagged() {
		if (!activeTag || taggedLoading) return;
		taggedLoading = true;
		await loadTagged(activeTag, taggedPage + 1).catch(() => (taggedHasMore = false));
		taggedLoading = false;
	}

	async function chooseTag(id: string) {
		if (activeTag === id) {
			activeTag = null;
			return;
		}
		activeTag = id;
		tagged = [];
		taggedHasMore = false;
		await loadTagged(id, 0).catch(() => {
			error.set("Couldn't load the chats with that tag. Please try again.");
		});
	}

	// The filtered rows follow the rail's own copy when it has one, so a rename or a pin shows at once,
	// and a chat that lost the tag leaves the filtered list.
	const taggedShown = $derived.by(() => {
		const live = new Map(conversations.map((c) => [String(c.id), c]));
		return tagged
			.map((c) => live.get(String(c.id)) ?? c)
			.filter((c) => activeTag !== null && (c.tags ?? []).includes(activeTag));
	});

	async function tagConversation(id: string, names: string[]) {
		if (!(await ontagConversation?.(id, names))) return;
		await refreshTags();
		if (activeTag) await loadTagged(activeTag, 0).catch(() => undefined);
	}

	// A chat that leaves the rail leaves the filtered list too, and may take its last use of a tag with it.
	async function leaveFiltered(id: string, act?: (id: string) => unknown) {
		await act?.(id);
		tagged = tagged.filter((c) => String(c.id) !== id);
		if (tagsEnabled) await refreshTags();
	}
	const deleteRow = (id: string) => void leaveFiltered(id, ondeleteConversation);
	const archiveRow = (id: string) => void leaveFiltered(id, onarchiveConversation);

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
			{#each settingsExternalLinks(page.data.statusPageUrl) as link (link.href)}
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
	     per-user Files gate is on — the same gate /chat/storage enforces. -->
	{#if page.data.storageViewEnabled}
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
	{#if tagsEnabled && tags.length && !loading}
		<Inline gap="1" class="px-2 pb-2" role="group" aria-label={m.product_filterByTag()} data-tag-filter>
			{#each tags as tag (tag.id)}
				<Toggle pressed={activeTag === tag.id} onPressedChange={() => chooseTag(tag.id)} data-tag-chip={tag.id}>
					{tag.name}
				</Toggle>
			{/each}
		</Inline>
	{/if}
	{#if activeTag}
		<Sidebar.Section label={activeTagName}>
			{#each taggedShown as conv (conv.id)}
				<NavConversationItem
					{conv}
					ondeleteConversation={deleteRow}
					{onrenameConversation}
					{onpinConversation}
					onarchiveConversation={archiveRow}
					ontagConversation={tagConversation}
					knownTags={tags}
				/>
			{/each}
		</Sidebar.Section>
		{#if taggedHasMore}
			<InfiniteScroll onvisible={moreTagged} />
		{/if}
	{:else if loading}
		<NavConversationsSkeleton />
	{:else if hasAnyConversation}
		{#if pinnedConversations.length}
			<Sidebar.Section label={m.product_pinned()}>
				{#each pinnedConversations as conv (conv.id)}
					<NavConversationItem
						{conv}
						ondeleteConversation={deleteRow}
						{onrenameConversation}
						{onpinConversation}
						onarchiveConversation={archiveRow}
						ontagConversation={tagConversation}
						knownTags={tags}
					/>
				{/each}
			</Sidebar.Section>
		{/if}
		{#each Object.entries(groupedConversations) as [group, convs] (group)}
			{#if convs.length}
				<Sidebar.Section label={localizedTitles[group as keyof typeof localizedTitles]}>
					{#each convs as conv (conv.id)}
						<NavConversationItem
							{conv}
							ondeleteConversation={deleteRow}
							{onrenameConversation}
							{onpinConversation}
							onarchiveConversation={archiveRow}
							ontagConversation={tagConversation}
							knownTags={tags}
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

<!-- Above the account row: the dismissible "Get involved" card (not in settings). -->
{#if !inSettings}
	<GetInvolvedCard />
{/if}
<!-- Directly above the account row it points at: where the tour lives, after a skipped welcome. -->
<TourHint />

<!-- One account row at the foot; settings, appearance, help, the GDPR wipe and
     sign in/out all live in its menu (AccountMenu). -->
<Sidebar.Footer>
	<AccountMenu onlogout={handleLogout} {loggingOut} />
</Sidebar.Footer>

<ChatSearchDialog bind:open={searchOpen} {conversations} />
