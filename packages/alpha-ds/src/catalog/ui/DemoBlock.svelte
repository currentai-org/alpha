<!--
  @component
  A live example: the rendered preview on the design system's page surface, a per-demo mode flip
  (so every example can be checked in light and dark side by side), and its exact source below.
  The source is the same file that renders the preview — they cannot drift.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import RiMoonLine from '~icons/ri/moon-line';
	import RiSunLine from '~icons/ri/sun-line';
	import { cn, getThemeContext, Tooltip } from '@aipotluck/alpha-ds';
	import CodeBlock from './CodeBlock.svelte';

	let {
		component: Demo,
		code,
		html,
		id,
		class: className
	}: { component?: Component; code: string; html?: string; id?: string; class?: string } = $props();

	const theme = getThemeContext();
	let flipped = $state(false);
	const mode = $derived(flipped ? (theme?.resolvedMode === 'dark' ? 'light' : 'dark') : undefined);
</script>

<div {id} class={cn('flex scroll-mt-24 flex-col', className)}>
	<div
		data-mode={mode}
		data-surface="1"
		class="ds-demo-stage relative flex min-h-48 items-center justify-center overflow-x-auto border border-b-0 border-line-2 bg-surface-1 p-8 text-fg-1"
	>
		<div class="relative w-full">
			{#if Demo}<Demo />{:else}<p class="type-caption text-fg-3">Loading example…</p>{/if}
		</div>
		<div class="absolute top-2 right-2">
			<Tooltip.Root>
				<Tooltip.Trigger
					variant="ghost"
					size="icon-sm"
					aria-label="Preview in the other mode"
					aria-pressed={flipped}
					onclick={() => (flipped = !flipped)}
				>
					{#if (mode ?? theme?.resolvedMode) === 'dark'}<RiSunLine />{:else}<RiMoonLine />{/if}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Positioner side="left"
						><Tooltip.Popup>Flip mode</Tooltip.Popup></Tooltip.Positioner
					>
				</Tooltip.Portal>
			</Tooltip.Root>
		</div>
	</div>
	<CodeBlock {code} {html} collapsible />
</div>

<style>
	/* (A mask reads only alpha, so any opaque token works as the mask colour.)
	   A faint dot field that only shows toward the stage's edges, so the stage still reads as a
	   canvas but the example itself sits on clean surface — a line grid behind text and borders
	   fought every demo for attention. */
	.ds-demo-stage::before {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		background-image: radial-gradient(circle, var(--ds-grid) 1px, transparent 1.5px);
		background-size: 16px 16px;
		background-position: 8px 8px;
		mask-image: radial-gradient(ellipse 70% 80% at 50% 50%, transparent 40%, var(--ds-fg-1) 100%);
	}
</style>
