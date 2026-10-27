<!--
  @component
  `Composer.Chip` — an active tool shown beside the composer's tools ("Web search", "Read aloud").
  A quiet pill tinted with the theme's own ink over whatever it sits on — so it takes the composer's
  hue in every theme, where a raised surface can read cooler or warmer — with no outline, the tool's
  name, and a close button on its right edge that switches the tool off. The name is not a button: turning a tool on or changing how it behaves
  happens in the Tools menu; the chip only says it's on and offers the way out.
-->
<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import { cn } from '../../internal/cn.ts';

	let {
		icon: Glyph,
		ondismiss,
		dismissLabel = 'Turn off',
		disabled = false,
		class: className,
		children
	}: {
		icon?: Component<Record<string, unknown>>;
		/** Close button pressed — turn the tool off. */
		ondismiss?: () => void;
		/** Accessible name for the close button, e.g. "Turn off web search". */
		dismissLabel?: string;
		disabled?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<span
	class={cn(
		'inline-flex h-control-sm max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-pill tint-hover pr-0.5 pl-2.5 type-caption text-fg-1',
		'[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-accent-1-text',
		disabled && 'opacity-40',
		className
	)}
	data-composer-chip
>
	{#if Glyph}<Glyph aria-hidden="true" />{/if}
	<span class="min-w-0 truncate">{@render children?.()}</span>
	<button
		type="button"
		class="inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-fg-3 transition-control hover:tint-active hover:text-fg-1 disabled:pointer-events-none [&_svg]:size-3.5"
		aria-label={dismissLabel}
		title={dismissLabel}
		{disabled}
		onclick={() => ondismiss?.()}
	>
		<RiCloseLine aria-hidden="true" />
	</button>
</span>
