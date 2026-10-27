<script lang="ts">
	import { controlSizes, layout, space } from '../../tokens/scales.ts';
	import PageHead from './PageHead.svelte';
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Spacing & size"
		lead="A 4px grid shared by CSS tokens and Tailwind’s spacing scale. Primitives accept named gaps only; the linter rejects arbitrary lengths."
	/>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Space</h2>
		<div class="flex flex-col border border-line-2">
			{#each Object.entries(space) as [key, v] (key)}
				<div class="flex items-center gap-4 border-b border-line-1 px-4 py-2 last:border-b-0">
					<code class="w-24 shrink-0 type-code text-fg-1">{key}</code>
					<span class="w-12 shrink-0 font-mono text-micro text-fg-3">{v}</span>
					<span class="ds-bar h-3 bg-fg-1" style:--size={v}></span>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Control heights</h2>
		<div class="flex flex-wrap items-end gap-4">
			{#each Object.entries(controlSizes) as [key, v] (key)}
				<div class="flex flex-col items-center gap-2">
					<div class="ds-control w-20 border border-line-3 bg-surface-2" style:--size={v}></div>
					<code class="type-code text-fg-2">control-{key}</code>
					<span class="font-mono text-micro text-fg-3">{v}</span>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Layout</h2>
		<div class="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2">
			{#each Object.entries(layout) as [key, v] (key)}
				<div class="flex justify-between bg-surface-1 px-4 py-3">
					<code class="type-code text-fg-1">--ds-{key}</code><span
						class="font-mono text-micro text-fg-3">{v}</span
					>
				</div>
			{/each}
		</div>
	</section>
</div>

<style>
	.ds-bar {
		width: var(--size);
	}
	.ds-control {
		height: var(--size);
	}
</style>
