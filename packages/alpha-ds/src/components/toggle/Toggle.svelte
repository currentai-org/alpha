<!--
  @component
  Base UI `Toggle` (engine: bits-ui Toggle.Root) — a two-state button. Inside a `ToggleGroup`
  it becomes a group item automatically.
-->
<script lang="ts">
	import { Toggle as Engine, ToggleGroup as GroupEngine, type ToggleRootProps } from 'bits-ui';
	import { getContext } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { toggleRecipe, type ToggleVariants } from './toggle.recipe.ts';

	let {
		pressed = $bindable(false),
		value = '',
		variant,
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<ToggleRootProps, 'children' | 'child'> &
		ToggleVariants & { value?: string; children?: import('svelte').Snippet } = $props();

	const group = getContext<{ variant: ToggleVariants['variant'] } | undefined>(
		'alpha-ds.toggle-group'
	);
	const classes = $derived(cn(toggleRecipe({ variant: variant ?? group?.variant }), className));
</script>

{#if group}
	<GroupEngine.Item
		bind:ref={() => ref ?? null, (v) => (ref = v)}
		{value}
		{...rest}
		class={classes}
	>
		{@render children?.()}
	</GroupEngine.Item>
{:else}
	<Engine.Root
		bind:pressed
		bind:ref={() => ref ?? null, (v) => (ref = v)}
		{...rest}
		class={classes}
	>
		{@render children?.()}
	</Engine.Root>
{/if}
