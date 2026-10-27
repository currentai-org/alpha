<!--
  @component
  `ComposerAccessory.Notice` — one line about what is in, or was just refused by, the composer,
  attached to its top edge at its full width: a file that could not be attached, a photo the chosen
  model will not read. It belongs to the message being written, so it sits by the composer rather
  than in the app-wide toast, and stays until it is dismissed or its cause goes away.

  ```svelte
  <ComposerAccessory.Notice icon={RiImageLine} ondismiss={() => (notice = undefined)}>
    Apertus can't read photos.
  </ComposerAccessory.Notice>
  <Composer.Root>…</Composer.Root>
  ```
-->
<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import { cn } from '../../internal/cn.ts';
	import { revealSlide } from '../../internal/motion.ts';
	import { noticeRecipe } from './composer-accessory.recipe.ts';

	let {
		icon: Icon,
		ondismiss,
		dismissLabel = 'Dismiss',
		action,
		class: className,
		children,
		...rest
	}: {
		/** Remix icon before the text. */
		icon?: Component;
		/** Shows a close button; the owner clears whatever raised the notice. */
		ondismiss?: () => void;
		/** Accessible name of the close button. */
		dismissLabel?: string;
		/** One small control after the text, e.g. a ghost Button that fixes the cause. */
		action?: Snippet;
		class?: string;
		children?: Snippet;
		[attr: `data-${string}`]: unknown;
	} = $props();
</script>

<div
	{...rest}
	role="status"
	aria-live="polite"
	class={cn(noticeRecipe(), className)}
	data-composer-notice
	transition:revealSlide
>
	{#if Icon}<Icon aria-hidden="true" class="size-4 shrink-0 text-fg-2" />{/if}
	<p class="m-0 min-w-0 flex-1">{@render children?.()}</p>
	{#if action}<div class="shrink-0">{@render action()}</div>{/if}
	{#if ondismiss}
		<button
			type="button"
			class={cn(buttonRecipe({ variant: 'ghost', size: 'icon-xs' }), 'shrink-0')}
			aria-label={dismissLabel}
			onclick={() => ondismiss()}
		>
			<RiCloseLine aria-hidden="true" />
		</button>
	{/if}
</div>
