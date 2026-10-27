<script lang="ts">
	import { Button } from '@aipotluck/alpha-ds';
	import { motion } from '../../tokens/scales.ts';
	import PageHead from './PageHead.svelte';

	let on = $state(false);
	const durations = Object.entries(motion).filter(([k]) => k.startsWith('duration'));
	const easings = Object.entries(motion).filter(([k]) => k.startsWith('ease'));
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Motion"
		lead="Brutalism reads as immediate: short durations, exits faster than entrances, no springs. Every duration collapses to 0 under prefers-reduced-motion."
	/>
	<Button onclick={() => (on = !on)} class="self-start">Play</Button>
	<div class="flex flex-col border border-line-2">
		{#each durations as [k, v] (k)}
			<div class="flex items-center gap-4 border-b border-line-1 px-4 py-3 last:border-b-0">
				<code class="w-40 shrink-0 type-code text-fg-1">--ds-{k}</code>
				<span class="w-14 font-mono text-micro text-fg-3">{v}</span>
				<div class="relative h-3 flex-1 bg-line-1">
					<span class="ds-runner" data-on={on ? '' : undefined} style:--run="var(--ds-{k})"></span>
				</div>
			</div>
		{/each}
	</div>
	<div class="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-3">
		{#each easings as [k, v] (k)}
			<div class="flex flex-col gap-1 bg-surface-1 p-4">
				<code class="type-code text-fg-1">--ds-{k}</code><span
					class="font-mono text-micro text-fg-3">{v}</span
				>
			</div>
		{/each}
	</div>
</div>

<style>
	.ds-runner {
		position: absolute;
		top: 0;
		left: 0;
		width: 0.75rem;
		height: 0.75rem;
		background: var(--ds-fg-1);
		transition: left var(--run) var(--ds-ease-standard);
	}
	.ds-runner[data-on] {
		left: calc(100% - 0.75rem);
	}
</style>
