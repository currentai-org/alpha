<!--
  @component
  Base UI `Collapsible.Root` (engine: bits-ui Collapsible.Root).
-->
<script lang="ts">
	import { Collapsible as Engine, type CollapsibleRootProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		open = $bindable(false),
		class: className,
		children,
		...rest
	}: CollapsibleRootProps = $props();
</script>

<Engine.Root bind:open {...rest} class={cn('flex flex-col', className)}>
	{@render children?.()}
</Engine.Root>
