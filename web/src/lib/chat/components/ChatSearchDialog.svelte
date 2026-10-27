<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { goto } from '$app/navigation';
	import { base } from '$lib/chat/paths';
	import { Dialog, Input, Kbd, Button, Sheet, useCompact } from '@aipotluck/alpha-ds';
	import RiSearchLine from '~icons/ri/search-line';
	import RiChat3Line from '~icons/ri/chat-3-line';
	import RiChatNewLine from '~icons/ri/chat-new-line';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	import RiCloseCircleFill from '~icons/ri/close-circle-fill';
	import RiInboxLine from '~icons/ri/inbox-line';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';

	type SearchConv = ConvSidebar & { snippet?: string };

	/**
	 * "Search chats": find a past conversation by its title or by something said in it, or start a new
	 * one — in plain words, with results grouped by when they happened and the matching words
	 * highlighted. Titles already loaded in the sidebar filter instantly; the whole history, messages
	 * included, comes from the server a moment later (CUR-2630). If that request fails, the loaded
	 * titles are all it shows, and it says so. Opens from the sidebar or ⌘K.
	 *
	 * Typing something that isn't a past chat offers "Ask Alpha: …", which starts a new chat with that
	 * text in the message box (the `?prompt=` handoff ChatLanding already supports).
	 */
	let {
		open = $bindable(false),
		conversations,
		embeddedDemo = false,
		onEmbeddedNavigate
	}: {
		open?: boolean;
		conversations: ConvSidebar[];
		embeddedDemo?: boolean;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	} = $props();

	const phone = useCompact();
	let query = $state('');
	let active = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	const q = $derived(query.trim().toLowerCase());

	// The server's answer for the query it was asked, so a late reply for an older query is ignored.
	let remote = $state<{ q: string; hits: SearchConv[] } | null>(null);
	let remoteFailed = $state(false);
	let searching = $state(false);
	$effect(() => {
		const asked = q;
		remote = null;
		remoteFailed = false;
		searching = false;
		if (embeddedDemo || asked.length < 2) return;
		searching = true;
		const ctrl = new AbortController();
		const timer = setTimeout(async () => {
			try {
				// The query goes in the body: request logs keep the URL (CUR-4546).
				const res = await fetch(`${base}/api/conversations/search`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ q: asked }),
					signal: ctrl.signal
				});
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as {
					conversations: { id: string; title: string; updatedAt: string; model?: string; snippet?: string }[];
				};
				remote = {
					q: asked,
					hits: body.conversations.map((c) => ({ ...c, updatedAt: new Date(c.updatedAt) }))
				};
			} catch {
				if (!ctrl.signal.aborted) remoteFailed = true;
			} finally {
				if (!ctrl.signal.aborted) searching = false;
			}
		}, 200);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	});

	const matches = $derived.by((): SearchConv[] => {
		if (!q) return conversations.slice(0, 50);
		const local: SearchConv[] = conversations.filter((c) => c.title.toLowerCase().includes(q));
		if (remote?.q !== q) return local.slice(0, 50);
		// The server searched every chat. A loaded title it didn't return, such as a chat made after
		// the request went out, still shows.
		const hits = remote.hits;
		const fresh = local.filter((c) => !hits.some((h) => String(h.id) === String(c.id)));
		return [...hits, ...fresh]
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
			.slice(0, 50);
	});

	type Row =
		| { kind: 'new'; label: string }
		| { kind: 'ask'; label: string }
		| { kind: 'chat'; conv: SearchConv; group: string };

	const DAY = 24 * 60 * 60 * 1000;
	function groupOf(d: Date): string {
		const now = new Date(Date.now());
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const timestamp = new Date(d).getTime();
		if (timestamp >= start) return m.product_today();
		if (timestamp >= start - DAY) return m.product_yesterday();
		if (timestamp >= start - 7 * DAY) return m.product_earlierWeek();
		if (timestamp >= start - 30 * DAY) return m.product_thisMonth();
		return m.product_older();
	}

	function when(d: Date): string {
		const diff = Date.now() - new Date(d).getTime();
		const min = Math.round(diff / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min} min ago`;
		const h = Math.round(min / 60);
		if (h < 24) return `${h} h ago`;
		const days = Math.round(h / 24);
		if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
		return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	}

	const rows = $derived.by(() => {
		const out: Row[] = [];
		if (q) out.push({ kind: 'ask', label: query.trim() });
		else out.push({ kind: 'new', label: m.product_startChat() });
		for (const conv of matches) out.push({ kind: 'chat', conv, group: groupOf(conv.updatedAt) });
		return out;
	});

	$effect(() => {
		// Keep the highlighted row valid as results change; prefer the first chat when searching.
		if (active >= rows.length) active = Math.max(0, rows.length - 1);
	});
	$effect(() => {
		void q;
		active = q && matches.length ? 1 : 0;
	});

	/** Split text around the query for highlighting (case-insensitive, first match). */
	function parts(title: string): [string, string, string] {
		if (!q) return [title, '', ''];
		const i = title.toLowerCase().indexOf(q);
		if (i < 0) return [title, '', ''];
		return [title.slice(0, i), title.slice(i, i + q.length), title.slice(i + q.length)];
	}

	function run(row: Row) {
		open = false;
		if (embeddedDemo) {
			onEmbeddedNavigate?.(
				row.kind === 'chat'
					? { kind: 'conversation', id: String(row.conv.id) }
					: { kind: 'new-chat', prompt: row.kind === 'ask' ? row.label : undefined }
			);
			return;
		}
		if (row.kind === 'chat') goto(`${base}/conversation/${row.conv.id}`);
		else if (row.kind === 'ask') goto(`${base}/?prompt=${encodeURIComponent(row.label)}`);
		else goto(`${base}/`);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, rows.length - 1);
			scrollActive();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
			scrollActive();
		} else if (e.key === 'Enter' && rows[active]) {
			e.preventDefault();
			run(rows[active]);
		}
	}

	function scrollActive() {
		queueMicrotask(() =>
			document.querySelector(`[data-search-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
		);
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
			if (document.getElementById('app')?.hasAttribute('inert') && !open) return;
			e.preventDefault();
			open = !open;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet rowButton(row: Row, i: number)}
	<button
		type="button"
		role="option"
		aria-selected={i === active}
		data-search-row={i}
		class="flex min-h-control-lg w-full items-center gap-3 px-3 py-2 text-left rounded-sharp transition-control aria-selected:bg-tint-hover hover:bg-tint-subtle"
		onmouseenter={() => (active = i)}
		onclick={() => run(row)}
	>
		{#if row.kind === 'chat'}
			<RiChat3Line class="size-4 shrink-0 text-fg-3" aria-hidden="true" />
			{@const [a, m, b] = parts(row.conv.title)}
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="truncate type-body text-fg-1"
					>{a}{#if m}<mark class="bg-accent-1/25 text-fg-1 rounded-sharp">{m}</mark>{/if}{b}</span
				>
				{#if row.conv.snippet}
					{@const [sa, sm, sb] = parts(row.conv.snippet)}
					<span class="truncate type-caption text-fg-3" data-search-snippet
						>{sa}{#if sm}<mark class="bg-accent-1/25 text-fg-2 rounded-sharp">{sm}</mark>{/if}{sb}</span
					>
				{/if}
			</span>
			<span class="shrink-0 type-caption text-fg-3">{when(row.conv.updatedAt)}</span>
		{:else if row.kind === 'ask'}
			<span class="grid size-7 shrink-0 place-items-center bg-accent-1/15 text-accent-1-text rounded-pill">
				<RiSparkling2Line class="size-4" aria-hidden="true" />
			</span>
			<span class="min-w-0 flex-1 truncate type-body text-fg-1">
				{m.product_askAlpha()} <span class="text-fg-2">“{row.label}”</span>
			</span>
			<span class="shrink-0 type-caption text-fg-3">{m.product_newChat()}</span>
		{:else}
			<span class="grid size-7 shrink-0 place-items-center bg-tint-hover text-fg-1 rounded-pill">
				<RiChatNewLine class="size-4" aria-hidden="true" />
			</span>
			<span class="min-w-0 flex-1 type-body text-fg-1">{row.label}</span>
		{/if}
	</button>
{/snippet}

{#snippet palette()}
			<div class="flex items-center gap-3 border-b border-line-surface px-4 py-1">
				<RiSearchLine class="size-5 shrink-0 text-fg-2" aria-hidden="true" />
				<Input
					bind:ref={inputEl}
					bind:value={query}
					{onkeydown}
					placeholder={m.product_searchPlaceholder()}
					aria-label={m.product_searchChats()}
					aria-controls="chat-search-results"
					size="lg"
					appearance="bare"
				/>
				{#if query}
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={m.product_clearSearch()}
						onclick={() => {
							query = '';
							inputEl?.focus();
						}}
					>
						<RiCloseCircleFill aria-hidden="true" />
					</Button>
				{/if}
			</div>

			<div
				id="chat-search-results"
				role="listbox"
				aria-label={m.product_chats()}
				class="scrollbar-custom scroll-fade-y flex max-h-96 min-h-0 flex-col gap-0.5 overflow-y-auto p-2 max-md:max-h-none max-md:flex-1"
				data-chat-search-results
			>
				{#each rows as row, i (row.kind === 'chat' ? row.conv.id : row.kind)}
					{#if row.kind === 'chat' && (i === 0 || rows[i - 1].kind !== 'chat' || (rows[i - 1] as { group?: string }).group !== row.group)}
						<div role="presentation" class="px-3 pt-3 pb-1 type-label text-fg-3">{row.group}</div>
					{/if}
					{@render rowButton(row, i)}
				{/each}
				{#if !matches.length}
					<div class="flex flex-col items-center gap-2 px-6 py-8 text-center">
						<RiInboxLine class="size-6 text-fg-3" aria-hidden="true" />
						<p class="type-body text-fg-2">
							{#if searching}
								{m.product_searchingAllChats()}
							{:else if conversations.length}
								{m.product_noPastChats({ query: query.trim() })}
							{:else}
								Your chats will show up here once you start one.
							{/if}
						</p>
						{#if remoteFailed}
							<p class="type-caption text-fg-3">
								{m.product_searchFellBackToTitles()}
							</p>
						{:else}
							<p class="type-caption text-fg-3">{m.product_searchAllChats()}</p>
						{/if}
					</div>
				{/if}
			</div>

			<div class="hidden items-center gap-4 border-t border-line-surface px-4 py-2 type-caption text-fg-3 sm:flex">
				<span class="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {m.product_move()}</span>
				<span class="flex items-center gap-1"><Kbd>↵</Kbd> {m.product_open()}</span>
				<span class="flex items-center gap-1"><Kbd>Esc</Kbd> {m.product_close()}</span>
				<span class="ml-auto flex items-center gap-1"><Kbd mod>K</Kbd> {m.product_searchAnywhere()}</span>
			</div>
{/snippet}

<!-- Phones: a bottom sheet with the shared header. Larger screens: a palette near the top. -->
{#if phone.current}
	<Sheet.Root
		bind:open
		onOpenChangeComplete={(o) => {
			if (!o) {
				query = '';
				active = 0;
			}
		}}
	>
		<Sheet.Portal>
			<Sheet.Backdrop />
			<Sheet.Popup aria-label={m.product_searchChats()}>
				<Sheet.Header title={m.product_searchChats()} />
				{@render palette()}
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{:else}
<Dialog.Root
	bind:open
	onOpenChangeComplete={(o) => {
		if (!o) {
			query = '';
			active = 0;
		}
	}}
>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="md" placement="top" padded={false} aria-label={m.product_searchChats()}>
			<Dialog.Title class="sr-only">{m.product_searchChats()}</Dialog.Title>
			{@render palette()}
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
{/if}
