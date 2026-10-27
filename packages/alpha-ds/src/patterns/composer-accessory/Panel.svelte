<!--
  @component
  `ComposerAccessory.Panel` — the content a `Pill` opens. Renders in flow at the Root's full width
  (so it always matches the composer), only while open; its height eases open and shut, so the
  composer and the page around it glide. On phones it opens as a bottom `Sheet` instead, with
  `title` (default: `label`) in the shared sheet header.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import { cn } from '../../internal/cn.ts';
	import { revealSlide } from '../../internal/motion.ts';
	import { getComposerAccessory } from './context.ts';
	import { panelRecipe } from './composer-accessory.recipe.ts';
	import { Sheet, useCompact } from '../../components/sheet/index.ts';

	let {
		value,
		label,
		title,
		tone = 'default',
		closable = true,
		class: className,
		children
	}: {
		value: string;
		/** Accessible name for the region. */
		label: string;
		/** Sheet header title on phones. Defaults to `label`. */
		title?: string;
		/** Show the close button in the upper right (default). Outside clicks don't close a panel. */
		closable?: boolean;
		/** `xray` — the radiograph look for the XRAY entry point. `seed` — a language Alpha is still learning. */
		tone?: 'default' | 'xray' | 'seed';
		class?: string;
		children?: Snippet;
	} = $props();

	const ctx = getComposerAccessory();
	const compact = useCompact();

	/*
	 * The panel's transition is `revealSlide` on the slow duration: height and opacity ease together. Switching panels runs one panel's exit beside the other's
	 * entrance, and the outgoing panel is still in flow until it has gone. `slide` mirrors its easing
	 * on the way out, so the two heights trade places and their sum only ever moves from one panel's
	 * height to the other's; likewise the opacities sum to 1. A bare fade would leave both panels at
	 * full height for its whole length.
	 */
</script>

{#if compact.current}
	<Sheet.Root
		open={ctx.open === value}
		onOpenChange={(o) => {
			if (!o && ctx.open === value) ctx.close();
		}}
	>
		<Sheet.Portal>
			<Sheet.Backdrop />
			<Sheet.Popup
				data-accessory-panel={value}
				aria-label={label}
				class={tone === 'xray'
					? 'xray-band border-xray-line'
					: tone === 'seed'
						? 'seed-band'
						: undefined}
			>
				<Sheet.Header title={title ?? label} />
				<Sheet.Body>{@render children?.()}</Sheet.Body>
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{:else if ctx.open === value}
	<section
		id="{ctx.baseId}-{value}"
		aria-label={label}
		class={cn(panelRecipe({ tone }), className)}
		data-accessory-panel={value}
		transition:revealSlide={{ duration: 'slow' }}
	>
		{#if closable}
			<button
				type="button"
				class={cn(buttonRecipe({ variant: 'ghost', size: 'icon-xs' }), 'absolute top-2 right-2')}
				aria-label="Close {label}"
				onclick={() => ctx.close()}
				data-accessory-close
			>
				<RiCloseLine aria-hidden="true" />
			</button>
		{/if}
		{@render children?.()}
	</section>
{/if}
