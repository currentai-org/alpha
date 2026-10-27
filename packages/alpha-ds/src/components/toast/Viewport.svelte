<!--
  @component
  Base UI `Toast.Viewport` — the live region toasts render into. Portals to the theme host.
  Pass a `toast` snippet to replace the default `Toast.Root` layout.

  `position="corner"` is the app's own stack: bottom right on desktop, newest nearest the corner, and
  full width along the top on phones, newest on top. On desktop it sits `--toast-clearance` above the
  bottom edge, so a docked control (the chat composer sets it) is never covered. Up to three show at
  once; their timers hold while the pointer or focus is on the stack, and Escape dismisses the newest.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Portal from '../../internal/Portal.svelte';
	import { cn } from '../../internal/cn.ts';
	import { revealSlide } from '../../internal/motion.ts';
	import { useToastManager, type ToastItem } from './manager.svelte.ts';
	import Root from './Root.svelte';

	let {
		position = 'bottom-right',
		inline = false,
		max = 3,
		class: className,
		toast: toastSnippet
	}: {
		/** `corner`: bottom right on desktop, along the top on phones. */
		position?: 'corner' | 'bottom-right' | 'bottom-center' | 'top-center';
		/** Render in place instead of portalling (docs previews, contained demos). */
		inline?: boolean;
		/** How many show at once; older ones wait their turn. */
		max?: number;
		class?: string;
		toast?: Snippet<[ToastItem]>;
	} = $props();

	const manager = useToastManager();
	const shown = $derived(manager.toasts.slice(-max));

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		const newest = manager.toasts.at(-1);
		// Only a toast someone can close: one with no timer waits on what it reports.
		if (newest && newest.type !== 'loading') manager.dismiss(newest.id);
	}
</script>

<svelte:window {onkeydown} />

{#snippet list()}
	<section
		aria-label="Notifications"
		aria-live="polite"
		onpointerenter={() => manager.pause()}
		onpointerleave={() => manager.resume()}
		onfocusin={() => manager.pause()}
		onfocusout={() => manager.resume()}
		class={cn(
			'pointer-events-none z-toast flex w-[min(24rem,calc(100vw-2rem))] flex-col',
			!inline && 'fixed',
			!inline && position === 'bottom-right' && 'right-4 bottom-4',
			!inline && position === 'bottom-center' && 'bottom-4 left-1/2 -translate-x-1/2',
			!inline && position === 'top-center' && 'top-4 left-1/2 -translate-x-1/2',
			// Phones: full width along the top, newest first. Desktop: the bottom-right corner, newest last.
			!inline &&
				position === 'corner' &&
				'top-2 right-2 left-2 w-auto flex-col-reverse md:top-auto md:right-6 md:bottom-[calc(var(--toast-clearance,0px)+1.5rem)] md:left-auto md:w-[min(24rem,calc(100vw-3rem))] md:flex-col',
			className
		)}
	>
		{#each shown as item (item.id)}
			<div class="py-1" transition:revealSlide>
				{#if toastSnippet}{@render toastSnippet(item)}{:else}<Root toast={item} />{/if}
			</div>
		{/each}
	</section>
{/snippet}

{#if inline}{@render list()}{:else}<Portal>{@render list()}</Portal>{/if}
