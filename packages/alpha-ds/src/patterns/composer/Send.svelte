<!--
  @component
  `Composer.Send` — the one primary action: an accent-filled, fully-rounded icon button (spec:
  accent fill at icon-button scale, Radius 3 for in-chat CTAs). Turns into Stop while busy.
-->
<script lang="ts">
	import RiArrowUpLine from '~icons/ri/arrow-up-line';
	import RiStopFill from '~icons/ri/stop-fill';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import { getComposer } from './context.ts';

	let { label = 'Send message', class: className }: { label?: string; class?: string } = $props();
	const composer = getComposer();
</script>

{#if composer.busy}
	<button
		type="button"
		aria-label="Stop generating"
		class={cn(
			buttonRecipe({ variant: 'secondary', size: 'icon', shape: 'pill' }),
			'text-fg-1',
			className
		)}
		onclick={() => composer.stop()}
	>
		<RiStopFill aria-hidden="true" />
	</button>
{:else}
	<button
		type="submit"
		aria-label={label}
		disabled={!composer.canSubmit}
		data-disabled={composer.canSubmit ? undefined : ''}
		class={cn(buttonRecipe({ variant: 'accent', size: 'icon', shape: 'pill' }), className)}
	>
		<RiArrowUpLine aria-hidden="true" />
	</button>
{/if}
