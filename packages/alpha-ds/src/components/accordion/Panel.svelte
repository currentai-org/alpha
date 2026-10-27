<!--
  @component
  Base UI `Accordion.Panel` (engine: bits-ui Accordion.Content). Exposes
  `--accordion-panel-height` for custom animations (Base UI name) alongside bits-ui's own.
-->
<script lang="ts">
	import { Accordion as Engine, type AccordionContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		keepMounted = false,
		hiddenUntilFound = false,
		class: className,
		children,
		...rest
	}: Omit<AccordionContentProps, 'forceMount'> & { keepMounted?: boolean } = $props();
</script>

<Engine.Content
	forceMount={keepMounted || undefined}
	{hiddenUntilFound}
	{...rest}
	class={cn(
		'motion-collapse text-fg-2 [--accordion-panel-height:var(--bits-accordion-content-height)] ui-closed:data-[force-mount]:hidden',
		className
	)}
>
	<div class="pb-4">{@render children?.()}</div>
</Engine.Content>
