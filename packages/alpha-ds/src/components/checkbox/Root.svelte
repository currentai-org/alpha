<!--
  @component
  Base UI `Checkbox.Root` (engine: bits-ui Checkbox.Root). Put a `Checkbox.Indicator` inside.
-->
<script lang="ts">
	import { Checkbox as Engine, type CheckboxRootProps } from 'bits-ui';
	import { setContext } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';

	let {
		checked = $bindable(false),
		indeterminate = $bindable(false),
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<CheckboxRootProps, 'children' | 'child'> & {
		children?: import('svelte').Snippet;
	} = $props();

	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));

	setContext('alpha-ds.checkbox', {
		get checked() {
			return checked;
		},
		get indeterminate() {
			return indeterminate;
		}
	});
</script>

<Engine.Root
	bind:checked
	bind:indeterminate
	bind:ref={() => ref ?? null, (v) => (ref = v)}
	{...rest}
	{...wired}
	class={cn(
		'inline-flex size-4 shrink-0 items-center justify-center rounded-sharp border border-line-3 bg-surface-2 text-fg-1 transition-control',
		'hover:border-fg-2 ui-checked:border-fg-1 ui-checked:bg-fg-1 ui-checked:text-surface-1',
		'ui-indeterminate:border-fg-1 ui-indeterminate:bg-fg-1 ui-indeterminate:text-surface-1',
		'ui-disabled:cursor-not-allowed ui-disabled:opacity-40 ui-invalid:border-accent-2',
		className
	)}
>
	{@render children?.()}
</Engine.Root>
