<!--
  @component
  Base UI `ToggleGroup` (engine: bits-ui ToggleGroup.Root). Children are `Toggle`s. Base UI's
  value is always an array; `multiple` decides whether more than one may be pressed.
-->
<script lang="ts">
	import { ToggleGroup as Engine } from 'bits-ui';
	import { setContext, type Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import type { ToggleVariants } from '../toggle/toggle.recipe.ts';

	let {
		value = $bindable([]),
		multiple = false,
		disabled = false,
		orientation = 'horizontal',
		variant = 'segment',
		onValueChange,
		class: className,
		children,
		...rest
	}: {
		value?: string[];
		multiple?: boolean;
		disabled?: boolean;
		orientation?: 'horizontal' | 'vertical';
		variant?: ToggleVariants['variant'];
		/** Base UI `onValueChange` — called with the new pressed values. */
		onValueChange?: (value: string[]) => void;
		class?: string;
		children?: Snippet;
		'aria-label'?: string;
	} = $props();

	function set(next: string[]) {
		value = next;
		onValueChange?.(next);
	}

	setContext('alpha-ds.toggle-group', {
		get variant() {
			return variant;
		}
	});

	const classes = $derived(
		cn(
			'inline-flex gap-0.5 ui-vertical:flex-col',
			// Concentric with its items: item radius + the 2px inset + 1px border (still square when the
			// theme's items are square — min() adds nothing to a 0 radius).
			variant === 'segment' &&
				'border border-line-surface bg-surface-raised p-0.5 rounded-[calc(var(--ds-radius-sharp)+min(var(--ds-radius-sharp),3px))]',
			className
		)
	);
</script>

{#if multiple}
	<Engine.Root
		type="multiple"
		bind:value={() => value, (v: string[]) => set(v)}
		{disabled}
		{orientation}
		{...rest}
		class={classes}
	>
		{@render children?.()}
	</Engine.Root>
{:else}
	<Engine.Root
		type="single"
		bind:value={() => value[0] ?? '', (v: string) => set(v ? [v] : [])}
		{disabled}
		{orientation}
		{...rest}
		class={classes}
	>
		{@render children?.()}
	</Engine.Root>
{/if}
