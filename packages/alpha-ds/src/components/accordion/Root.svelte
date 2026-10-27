<!--
  @component
  Base UI `Accordion.Root` (engine: bits-ui Accordion.Root). `value` is always an array of open
  item values, as in Base UI; `multiple` allows more than one open at a time.
-->
<script lang="ts">
	import { Accordion as Engine } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		value = $bindable([]),
		multiple = false,
		disabled = false,
		orientation = 'vertical',
		loop = true,
		onValueChange,
		class: className,
		children
	}: {
		value?: string[];
		multiple?: boolean;
		disabled?: boolean;
		orientation?: 'vertical' | 'horizontal';
		loop?: boolean;
		onValueChange?: (value: string[]) => void;
		class?: string;
		children?: Snippet;
	} = $props();

	const classes = $derived(cn('flex w-full flex-col border-t border-line-surface', className));
	const set = (next: string[]) => {
		value = next;
		onValueChange?.(next);
	};
</script>

{#if multiple}
	<Engine.Root
		type="multiple"
		bind:value={() => value, set}
		{disabled}
		{orientation}
		{loop}
		class={classes}
	>
		{@render children?.()}
	</Engine.Root>
{:else}
	<Engine.Root
		type="single"
		bind:value={() => value[0] ?? '', (v: string) => set(v ? [v] : [])}
		{disabled}
		{orientation}
		{loop}
		class={classes}
	>
		{@render children?.()}
	</Engine.Root>
{/if}
