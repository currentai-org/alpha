<!--
  @component
  Base UI `Checkbox.Indicator` — renders while checked or indeterminate. Default glyphs are the
  Remix check / subtract lines; pass children to replace them.
-->
<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	import RiCheckLine from '~icons/ri/check-line';
	import RiSubtractLine from '~icons/ri/subtract-line';
	import { cn } from '../../internal/cn.ts';

	let {
		keepMounted = false,
		class: className,
		children
	}: { keepMounted?: boolean; class?: string; children?: Snippet } = $props();

	const state = getContext<{ checked: boolean; indeterminate: boolean }>('alpha-ds.checkbox');
	const visible = $derived(state.checked || state.indeterminate);
</script>

{#if visible || keepMounted}
	<span
		class={cn(
			'flex items-center justify-center [&_svg]:size-3.5',
			!visible && 'invisible',
			className
		)}
		data-checked={state.checked ? '' : undefined}
		data-indeterminate={state.indeterminate ? '' : undefined}
	>
		{#if children}
			{@render children()}
		{:else if state.indeterminate}
			<RiSubtractLine aria-hidden="true" />
		{:else}
			<RiCheckLine aria-hidden="true" />
		{/if}
	</span>
{/if}
