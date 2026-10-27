<script lang="ts">
	import { borderWidths, radii, shadows } from '../../tokens/scales.ts';
	import PageHead from './PageHead.svelte';

	const radiusUse: Record<string, string> = {
		sharp: 'Radius 1 — the default for everything.',
		field: 'Radius 2 — the chat composer and prompt-example buttons, only.',
		pill: 'Radius 3 — small in-chat CTAs: send, toggle pills.',
		popup: 'Menus and popovers — sharp plus their 4px inner padding, so row hovers sit concentric.',
		card: 'Bordered containers — cards, grouped settings, list boxes, tiles.'
	};
	const shadowClass: Record<string, string> = {
		window: 'shadow-window',
		popover: 'shadow-popover'
	};
	const radiusClass: Record<string, string> = {
		sharp: 'rounded-sharp',
		field: 'rounded-field',
		pill: 'rounded-pill',
		popup: 'rounded-popup',
		card: 'rounded-card'
	};
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Shape & elevation"
		lead="Sharp by default, hard rules, flat surfaces. Two shadows: the outer window, and a hairline plus soft lift for floating layers (menus, popovers, dialogs) — never a hard offset edge."
	/>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Radius</h2>
		<div class="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2 md:grid-cols-5">
			{#each Object.entries(radii) as [key, v] (key)}
				<div class="flex flex-col gap-3 bg-surface-1 p-5">
					<div class="h-16 w-full max-w-28 border-2 border-fg-1 {radiusClass[key]}"></div>
					<code class="type-code text-fg-1">rounded-{key} · {v}</code>
					<p class="type-caption text-fg-2">{radiusUse[key]}</p>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Rules</h2>
		<div class="flex flex-wrap gap-6">
			{#each ['line-1', 'line-2', 'line-3', 'line-strong'] as t (t)}
				<div class="flex flex-col gap-2">
					<div class="ds-rule h-16 w-28" style:--rule="var(--ds-{t})"></div>
					<code class="type-code text-fg-2">border-{t}</code>
				</div>
			{/each}
			{#each Object.entries(borderWidths) as [k, v] (k)}
				<div class="flex flex-col gap-2">
					<div class="ds-weight h-16 w-28" style:--weight={v}></div>
					<code class="type-code text-fg-2">{k} · {v}</code>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Shadows</h2>
		<div class="flex flex-wrap gap-10 p-4">
			{#each Object.keys(shadows).filter((k) => k !== 'none') as k (k)}
				<div class="flex flex-col gap-3">
					<div class={['h-20 w-36 border border-line-2 bg-surface-3', shadowClass[k]]}></div>
					<code class="type-code text-fg-2">shadow-{k}</code>
				</div>
			{/each}
		</div>
	</section>
</div>

<style>
	.ds-rule {
		border: 1px solid var(--rule);
	}
	.ds-weight {
		border: var(--weight) solid var(--ds-fg-1);
	}
</style>
