<!--
  @component
  ⌘K / Ctrl+K search across foundations, components, primitives and patterns — names, keywords,
  part names and descriptions. Arrow keys move, Enter opens.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import RiSearchLine from '~icons/ri/search-line';
	import { Badge, cn, Dialog, Kbd } from '@aipotluck/alpha-ds';
	import { LAYERS, search, type NavEntry } from '../registry.ts';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	let query = $state('');
	let active = $state(0);
	const results = $derived(search(query).slice(0, 12));
	const layerLabel = (e: NavEntry) => LAYERS.find((l) => l.layer === e.layer)?.label ?? e.layer;

	$effect(() => {
		void query;
		active = 0;
	});

	function go(e: NavEntry | undefined) {
		if (!e) return;
		open = false;
		query = '';
		void goto(resolve('/designsystem/[slug]', { slug: e.slug }));
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			go(results[active]);
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = !open;
		}
	}}
/>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="md" class="top-24 translate-y-0 gap-0 p-0">
			<Dialog.Title class="sr-only">Search the design system</Dialog.Title>
			<div class="flex items-center gap-2 border-b border-line-3 px-3">
				<RiSearchLine class="size-4 text-fg-3" aria-hidden="true" />
				<input
					bind:value={query}
					{onkeydown}
					placeholder="Search tokens, components, patterns…"
					aria-label="Search"
					aria-controls="ds-search-results"
					aria-activedescendant={results[active] ? `ds-result-${results[active].slug}` : undefined}
					class="h-12 flex-1 bg-transparent type-body text-fg-1 outline-none placeholder:text-fg-3 focus-visible:outline-none"
				/>
				<Kbd>esc</Kbd>
			</div>
			<ul id="ds-search-results" role="listbox" class="max-h-96 overflow-y-auto p-1">
				{#each results as e, i (e.slug)}
					<li
						id="ds-result-{e.slug}"
						role="option"
						aria-selected={i === active}
						class={cn(
							'flex cursor-pointer items-center gap-3 px-3 py-2',
							i === active ? 'bg-tint-hover text-fg-1' : 'text-fg-2'
						)}
						onpointermove={() => (active = i)}
						onclick={() => go(e)}
						onkeydown={() => {}}
					>
						<div class="min-w-0 flex-1">
							<p class="type-body text-fg-1">{e.name}</p>
							<p class="truncate type-caption text-fg-3">{e.description}</p>
						</div>
						<Badge>{layerLabel(e)}</Badge>
					</li>
				{:else}
					<li class="px-3 py-6 type-caption text-fg-3">No results for “{query}”.</li>
				{/each}
			</ul>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
