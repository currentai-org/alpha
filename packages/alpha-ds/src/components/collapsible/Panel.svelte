<!--
  @component
  Base UI `Collapsible.Panel` (engine: bits-ui Collapsible.Content).
-->
<script lang="ts">
	import { Collapsible as Engine, type CollapsibleContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		keepMounted = false,
		class: className,
		children,
		...rest
	}: Omit<CollapsibleContentProps, 'forceMount'> & { keepMounted?: boolean } = $props();
</script>

<Engine.Content
	forceMount={keepMounted || undefined}
	{...rest}
	class={cn(
		'motion-collapse [--collapsible-panel-height:var(--bits-collapsible-content-height)] ui-closed:data-[force-mount]:hidden',
		className
	)}
>
	{@render children?.()}
</Engine.Content>
