<!--
  @component
  Base UI `Menu.LinkItem` — a menu row that navigates (renders an `<a>`).
-->
<script lang="ts">
	import { DropdownMenu as Engine } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		href,
		target,
		onclick,
		class: className,
		children
	}: {
		href: string;
		target?: string;
		/** Runs before navigation; call `preventDefault()` to intercept (e.g. an embedded demo). */
		onclick?: (e: MouseEvent) => void;
		class?: string;
		children?: Snippet;
	} = $props();

	// Chain, don't replace: the engine's own onclick is what selects the item and closes the menu.
	// It still runs when the consumer intercepts navigation, so the menu always dismisses.
	const chain = (engine: unknown) => (e: MouseEvent) => {
		onclick?.(e);
		(engine as ((e: MouseEvent) => void) | undefined)?.(e);
	};
</script>

<Engine.Item>
	{#snippet child({ props })}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- consumer passes a resolved href -->
		<a {...props} {href} {target} onclick={chain(props.onclick)} class={cn(itemRecipe(), className)}
			>{@render children?.()}</a
		>
	{/snippet}
</Engine.Item>
