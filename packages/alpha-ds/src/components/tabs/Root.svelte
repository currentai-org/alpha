<!--
  @component
  Base UI `Tabs.Root` (engine: bits-ui Tabs.Root). `variant` picks the skin its List and Tabs draw:
  `line` (a ruled strip, ink bar under the selected tab) or `segment` (a segmented control, for a few
  peer views such as storage locations). `wrap` keeps each tab's label whole and in its own case,
  wrapping it when long, for labels that are names someone chose.
-->
<script lang="ts">
	import { Tabs as Engine, type TabsRootProps } from 'bits-ui';
	import { setContext } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import type { TabsVariant } from './tabs.recipe.ts';

	let {
		value = $bindable(''),
		variant = 'line',
		wrap = false,
		class: className,
		children,
		...rest
	}: TabsRootProps & { variant?: TabsVariant; wrap?: boolean } = $props();

	setContext('alpha-ds.tabs', {
		get variant() {
			return variant;
		},
		get wrap() {
			return wrap;
		}
	});
</script>

<Engine.Root bind:value {...rest} class={cn('flex flex-col gap-4 ui-vertical:flex-row', className)}>
	{@render children?.()}
</Engine.Root>
