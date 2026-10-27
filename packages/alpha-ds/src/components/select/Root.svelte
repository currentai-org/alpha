<!--
  @component
  Base UI `Select.Root` (engine: bits-ui Select.Root, single-select). Pass `items` so
  `Select.Value` can show the selected label before the popup has ever opened (Base UI's
  `items` prop does the same).
-->
<script lang="ts">
	import { Select as Engine } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		value = $bindable(''),
		open = $bindable(false),
		items = [],
		name,
		disabled = false,
		required = false,
		onValueChange,
		children
	}: {
		value?: string;
		open?: boolean;
		items?: { value: string; label: string; disabled?: boolean }[];
		name?: string;
		disabled?: boolean;
		required?: boolean;
		onValueChange?: (value: string) => void;
		children?: Snippet;
	} = $props();
</script>

<Engine.Root
	type="single"
	bind:value
	bind:open
	{items}
	{name}
	{disabled}
	{required}
	{onValueChange}
>
	{@render children?.()}
</Engine.Root>
