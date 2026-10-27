<!--
  @component
  Base UI `Tabs.Root` (engine: bits-ui Tabs.Root). `variant` picks the skin its List and Tabs draw:
  `line` (a ruled strip, ink bar under the selected tab) or `segment` (a segmented control, for a few
  peer views such as storage locations).
-->
<script lang="ts">
	import { Tabs as Engine, type TabsRootProps } from 'bits-ui';
	import { setContext } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import type { TabsVariant } from './tabs.recipe.ts';

	let {
		value = $bindable(''),
		variant = 'line',
		class: className,
		children,
		...rest
	}: TabsRootProps & { variant?: TabsVariant } = $props();

	setContext('alpha-ds.tabs', {
		get variant() {
			return variant;
		}
	});
</script>

<Engine.Root bind:value {...rest} class={cn('flex flex-col gap-4 ui-vertical:flex-row', className)}>
	{@render children?.()}
</Engine.Root>
