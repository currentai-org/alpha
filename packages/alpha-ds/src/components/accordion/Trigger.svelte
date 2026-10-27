<!--
  @component
  Base UI `Accordion.Trigger` (engine: bits-ui Accordion.Trigger). Left-aligned label, a plus
  that turns into a minus (brutalist: no rotation easing, a hard swap).
-->
<script lang="ts">
	import { Accordion as Engine, type AccordionTriggerProps } from 'bits-ui';
	import RiAddLine from '~icons/ri/add-line';
	import RiSubtractLine from '~icons/ri/subtract-line';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: AccordionTriggerProps = $props();
</script>

<Engine.Trigger
	{...rest}
	class={cn(
		'group/trigger flex flex-1 items-center justify-between gap-4 py-3 text-left type-body font-medium text-fg-1 transition-control',
		'hover:tint-subtle hover:text-fg-1 ui-disabled:cursor-not-allowed ui-disabled:opacity-40',
		className
	)}
>
	<span class="min-w-0 flex-1">{@render children?.()}</span>
	<RiAddLine class="size-4 shrink-0 text-fg-2 group-ui-open/trigger:hidden" aria-hidden="true" />
	<RiSubtractLine
		class="hidden size-4 shrink-0 text-fg-1 group-ui-open/trigger:block"
		aria-hidden="true"
	/>
</Engine.Trigger>
