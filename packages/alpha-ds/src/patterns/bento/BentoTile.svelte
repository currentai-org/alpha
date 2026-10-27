<!--
  @component
  A landing-page bento tile: headline + one line of copy over a live, interactive scene built from
  the app's own tokens and data. Used by the /alpha landing page.
  Unlike the decorative vignettes, the scene is meant to be played with, so it stays in the
  accessibility tree.
-->
<script lang="ts">
	import { getContext, type Component, type Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { BENTO_COMPACT } from './context.ts';

	let {
		icon: Glyph,
		title,
		body,
		class: className,
		sceneClass,
		compact: compactProp,
		children
	}: {
		icon: Component<Record<string, unknown>>;
		title: string;
		body: string;
		class?: string;
		sceneClass?: string;
		/** Shorter tile. Defaults to the host's `BENTO_COMPACT` context. */
		compact?: boolean;
		children?: Snippet;
	} = $props();

	const compactContext = getContext<boolean | undefined>(BENTO_COMPACT) ?? false;
	const compact = $derived(compactProp ?? compactContext);
</script>

<article
	class={cn(
		'bento relative isolate flex min-w-0 flex-col overflow-hidden rounded-card border border-line-1 bg-surface-2',
		compact ? 'min-h-112' : 'min-h-120 md:min-h-136',
		className
	)}
	data-bento
>
	<div class="relative z-raised flex flex-col gap-1.5 p-5 pb-0 sm:p-6 sm:pb-0">
		<span class="flex items-center gap-2 type-caption text-accent-1-text">
			<Glyph aria-hidden="true" class="size-4" />
		</span>
		<h3 class="type-title text-fg-1">{title}</h3>
		<p class="max-w-md type-caption text-fg-2">{body}</p>
	</div>
	<div
		class={cn(
			'relative flex min-w-0 flex-1 items-center justify-center px-4 pt-6 pb-7 *:min-w-0 sm:px-6',
			sceneClass
		)}
	>
		{@render children?.()}
	</div>
</article>

<style>
	.bento::before {
		content: '';
		position: absolute;
		inset: auto -20% -40% -20%;
		height: 80%;
		z-index: -1;
		background: radial-gradient(
			ellipse at 50% 100%,
			color-mix(in oklch, var(--ds-accent-1) 26%, transparent),
			transparent 70%
		);
		pointer-events: none;
	}
</style>
