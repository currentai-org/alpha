<!--
  @component
  Base UI `RadioGroup` (engine: bits-ui RadioGroup.Root). Contains `Radio.Root` items.
-->
<script lang="ts">
	import { RadioGroup as Engine, type RadioGroupRootProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		value = $bindable(''),
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<RadioGroupRootProps, 'children' | 'child'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.Root
	bind:value
	bind:ref={() => ref ?? null, (v) => (ref = v)}
	{...rest}
	class={cn('flex flex-col gap-2 ui-horizontal:flex-row', className)}
>
	{@render children?.()}
</Engine.Root>
