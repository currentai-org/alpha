<!--
  @component
  Base UI `Radio.Root` (engine: bits-ui RadioGroup.Item). Radius 1, per spec — square by default, round in themes whose radius exceeds half its size.
-->
<script lang="ts">
	import { RadioGroup as Engine, type RadioGroupItemProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<RadioGroupItemProps, 'children' | 'child'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.Item
	bind:ref={() => ref ?? null, (v) => (ref = v)}
	{...rest}
	class={cn(
		'group/radio inline-flex size-4 shrink-0 items-center justify-center rounded-sharp border border-line-3 bg-surface-2 transition-control',
		'hover:border-fg-2 ui-checked:border-fg-1 ui-disabled:cursor-not-allowed ui-disabled:opacity-40',
		className
	)}
>
	{@render children?.()}
</Engine.Item>
