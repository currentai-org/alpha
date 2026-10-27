<!--
  @component
  Base UI `Accordion.Item` (engine: bits-ui Accordion.Item).
-->
<script lang="ts">
	import { Accordion as Engine, type AccordionItemProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AccordionItemProps = $props();
</script>

<Engine.Item {...rest} class={cn('border-b border-line-surface', className)}>
	{@render children?.()}
</Engine.Item>
