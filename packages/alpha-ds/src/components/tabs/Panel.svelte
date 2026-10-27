<!--
  @component
  Base UI `Tabs.Panel` (engine: bits-ui Tabs.Content).
-->
<script lang="ts">
	import { Tabs as Engine, type TabsContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: TabsContentProps = $props();
</script>

<Engine.Content {...rest} class={cn('min-w-0 flex-1 outline-none', className)}>
	{@render children?.()}
</Engine.Content>
