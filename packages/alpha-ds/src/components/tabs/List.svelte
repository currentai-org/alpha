<!--
  @component
  Base UI `Tabs.List` (engine: bits-ui Tabs.List). `line`: a hard rule under the tabs, and the
  selected tab draws its own ink bar on top of it. `segment`: a bordered segmented control.
-->
<script lang="ts">
	import { Tabs as Engine, type TabsListProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { tabsListRecipe, tabsVariant } from './tabs.recipe.ts';

	let { class: className, children, ...rest }: TabsListProps = $props();
	const variant = tabsVariant();
</script>

<Engine.List {...rest} class={cn(tabsListRecipe({ variant }), className)}>
	{@render children?.()}
</Engine.List>
