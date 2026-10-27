<!--
  @component
  Base UI `Switch.Root` (engine: bits-ui Switch.Root). Put a `Switch.Thumb` inside.
  Brutalist: a sharp track with a square thumb; "on" fills the track with ink.
-->
<script lang="ts">
	import { Switch as Engine, type SwitchRootProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';

	let {
		checked = $bindable(false),
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<SwitchRootProps, 'children' | 'child'> & {
		children?: import('svelte').Snippet;
	} = $props();

	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));
</script>

<Engine.Root
	bind:checked
	bind:ref={() => ref ?? null, (v) => (ref = v)}
	{...rest}
	{...wired}
	class={cn(
		'group/switch inline-flex h-5 w-9 shrink-0 items-center rounded-sharp border border-line-3 bg-surface-2 p-0.5 transition-control',
		'hover:border-fg-2 ui-checked:border-fg-1 ui-checked:bg-fg-1',
		'ui-disabled:cursor-not-allowed ui-disabled:opacity-40',
		className
	)}
>
	{@render children?.()}
</Engine.Root>
