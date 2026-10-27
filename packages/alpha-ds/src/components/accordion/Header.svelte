<!--
  @component
  Base UI `Accordion.Header` (engine: bits-ui Accordion.Header) — the heading element that wraps
  the trigger.
-->
<script lang="ts">
	import { Accordion as Engine, type AccordionHeaderProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { level = 3, class: className, children, ...rest }: AccordionHeaderProps = $props();
</script>

<Engine.Header {level} {...rest} class={cn('flex', className)}>
	{@render children?.()}
</Engine.Header>
