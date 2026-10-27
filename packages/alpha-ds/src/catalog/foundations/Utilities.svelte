<script lang="ts">
	import PageHead from './PageHead.svelte';
	import { UTILITY_GROUPS } from './utilities.ts';
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Utilities"
		lead="Hand-authored Tailwind utilities for spec rules Tailwind has no primitive for — tints, motion, edge fades, the XRAY identity. Source: tokens/utilities.css. Use these instead of one-off CSS."
	/>
	{#each UTILITY_GROUPS as group (group.title)}
		<section class="flex flex-col gap-4">
			<h2 class="border-b border-line-2 pb-2 type-heading">{group.title}</h2>
			<p class="max-w-2xl type-body text-fg-2">{group.lead}</p>
			<div class="flex flex-col overflow-hidden rounded-card border border-line-2">
				{#each group.items as u (u.name)}
					<div
						class="flex flex-col gap-3 border-b border-line-1 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-6"
					>
						<code class="w-44 shrink-0 type-code text-fg-1">{u.name}</code>
						<p class="flex-1 type-caption text-fg-2">{u.description}</p>
						{#if u.preview}<div class="flex h-20 w-32 shrink-0 items-center justify-center">
								{#if u.preview === 'tint'}
									<div
										class="flex size-full items-center justify-center rounded-sharp border border-line-2 bg-surface-2 type-caption text-fg-2 {u.previewClass}"
									>
										Aa
									</div>
								{:else if u.preview === 'mask'}
									<div class="size-full bg-fg-1 {u.previewClass}"></div>
								{:else if u.preview === 'scroll'}
									<div
										class="h-full w-full overflow-y-auto border border-line-2 px-2 type-caption text-fg-2 {u.previewClass}"
									>
										{#each Array.from({ length: 8 }, (_, i) => i + 1) as n (n)}<p>
												Line {n}
											</p>{/each}
									</div>
								{:else if u.preview === 'xray'}
									<div
										class="relative size-full rounded-sharp border border-xray-line bg-surface-2 {u.previewClass}"
									></div>
								{:else if u.preview === 'seed'}
									<div
										class="relative size-full rounded-card border border-line-2 bg-surface-raised {u.previewClass}"
									></div>
								{:else if u.preview === 'bar'}
									<div class="relative h-2 w-full bg-line-1">
										<span
											class="absolute inset-y-0 bg-fg-1 {u.previewClass}"
											style:--bar-width="60%"
										></span>
									</div>
								{:else if u.preview === 'swatch'}
									<div
										class="size-10 rounded-pill border border-line-2 {u.previewClass}"
										style:--swatch="var(--ds-accent-1)"
									></div>
								{/if}
							</div>{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
</div>
