<!--
  @component
  Base UI `Combobox.Root` (engine: bits-ui Combobox.Root, single-select). Filtering is the
  consumer's: keep a query from `Combobox.Input`'s `oninput` and render the matching items
  (`fuzzyFilter` ranks them). Pass `items` and `inputValue` so the input shows the selected label.
-->
<script lang="ts">
	import { Combobox as Engine } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { setComboboxContext } from './context.ts';

	let {
		value = $bindable(''),
		open = $bindable(false),
		items = [],
		inputValue,
		name,
		disabled = false,
		required = false,
		onValueChange,
		onOpenChange,
		children
	}: {
		value?: string;
		open?: boolean;
		items?: { value: string; label: string; disabled?: boolean }[];
		/** What the input shows when nobody is typing, usually the selected label. */
		inputValue?: string;
		name?: string;
		disabled?: boolean;
		required?: boolean;
		onValueChange?: (value: string) => void;
		onOpenChange?: (open: boolean) => void;
		children?: Snippet;
	} = $props();

	setComboboxContext({ openList: () => (open = true) });
</script>

<Engine.Root
	type="single"
	bind:value
	bind:open
	{items}
	{inputValue}
	{name}
	{disabled}
	{required}
	{onValueChange}
	{onOpenChange}
>
	{@render children?.()}
</Engine.Root>
