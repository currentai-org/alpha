<!--
  @component
  Base UI `Tabs.Tab` (engine: bits-ui Tabs.Trigger). Its skin follows the Root's `variant`.
-->
<script lang="ts">
	import { Tabs as Engine, type TabsTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { tabsTabRecipe, tabsVariant } from './tabs.recipe.ts';

	let { class: className, children, ...rest }: TabsTriggerProps = $props();
	const variant = tabsVariant();
</script>

<Engine.Trigger {...rest} class={cn(tabsTabRecipe({ variant }), className)}>
	{@render children?.()}
</Engine.Trigger>
