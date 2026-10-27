<!--
  @component
  Left navigation, grouped by layer (Base UI docs layout). Filters live as you type.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { cn, Input } from '@aipotluck/alpha-ds';
	import { LAYERS, search, type NavEntry } from '../registry.ts';

	let { onnavigate }: { onnavigate?: () => void } = $props();
	let filter = $state('');

	const entries = $derived(search(filter));
	const groups = $derived(
		LAYERS.map((l) => ({ ...l, items: entries.filter((e) => e.layer === l.layer) })).filter(
			(g) => g.items.length
		)
	);
	const current = $derived(page.params.slug ?? 'overview');
	const href = (e: NavEntry) => resolve('/designsystem/[slug]', { slug: e.slug });
</script>

<nav aria-label="Design system" class="flex min-h-0 flex-1 flex-col">
	<div class="px-4 pt-4 pb-3">
		<Input size="sm" bind:value={filter} placeholder="Filter…" aria-label="Filter navigation" />
	</div>
	<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-2 pb-8">
		{#each groups as group (group.layer)}
			<section>
				<h2 class="px-2 pb-1 type-label text-fg-3">
					{group.label} <span class="text-fg-3/60">{group.items.length}</span>
				</h2>
				<ul role="list" class="flex flex-col">
					{#each group.items as e (e.slug)}
						<li>
							<a
								href={href(e)}
								onclick={onnavigate}
								aria-current={current === e.slug ? 'page' : undefined}
								class={cn(
									'flex h-control-sm items-center justify-between gap-2 px-2 type-body text-fg-2 transition-control',
									'hover:bg-tint-subtle hover:text-fg-1',
									current === e.slug && 'bg-tint-hover text-fg-1 hover:bg-tint-hover'
								)}
							>
								<span class="truncate">{e.name}</span>
								{#if e.layer === 'component' && !e.baseUi}<span
										class="font-mono text-micro text-fg-3"
										title="Alpha addition — no Base UI equivalent">+α</span
									>{/if}
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			<p class="px-2 type-caption text-fg-3">Nothing matches “{filter}”.</p>
		{/each}
	</div>
</nav>
