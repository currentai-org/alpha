<!--
  @component
  `Sheet.Header` — the shared sheet header: title (and optional leading/trailing slots) with the
  close button in the upper right. Also a drag handle for swipe-to-dismiss.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Dialog as Engine } from 'bits-ui';
	import RiCloseLine from '~icons/ri/close-line';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe } from '../button/button.recipe.ts';

	let {
		title,
		titleClass,
		class: className,
		children
	}: { title: string; titleClass?: string; class?: string; children?: Snippet } = $props();
</script>

<div
	data-sheet-drag
	class={cn(
		'flex shrink-0 touch-none items-center gap-2 border-b border-line-1 px-4 pb-3',
		className
	)}
>
	<Engine.Title class={cn('min-w-0 flex-1 truncate type-title text-fg-1', titleClass)}
		>{title}</Engine.Title
	>
	{@render children?.()}
	<Engine.Close
		class={buttonRecipe({ variant: 'ghost', size: 'icon-sm' })}
		aria-label="Close"
		data-sheet-close
	>
		<RiCloseLine aria-hidden="true" />
	</Engine.Close>
</div>
