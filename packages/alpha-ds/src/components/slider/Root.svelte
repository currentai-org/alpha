<!--
  @component
  Base UI `Slider.Root` (engine: bits-ui Slider.Root). Anatomy: Root › Control › Track ›
  Indicator + Thumb. Single-value; `value` is a number.
-->
<script lang="ts">
	import { Slider as Engine } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		value = $bindable(0),
		min = 0,
		max = 100,
		step = 1,
		disabled = false,
		onValueCommitted,
		class: className,
		children,
		...rest
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		onValueCommitted?: (value: number) => void;
		class?: string;
		children?: Snippet;
		'aria-label'?: string;
	} = $props();
</script>

<Engine.Root
	type="single"
	bind:value
	{min}
	{max}
	{step}
	{disabled}
	onValueCommit={onValueCommitted}
	{...rest}
	class={cn(
		'relative flex w-full touch-none items-center select-none ui-disabled:opacity-40',
		className
	)}
>
	{@render children?.()}
</Engine.Root>
