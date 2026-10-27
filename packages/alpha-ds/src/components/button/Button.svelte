<!--
  @component
  Base UI `Button`. Renders a native `<button>`, or an `<a>` when `href` is set.
  Skin: button.recipe.ts.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { dev } from '$app/environment';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, isIconSize, type ButtonVariants } from './button.recipe.ts';

	type Common = ButtonVariants & {
		/** Focusable while disabled (Base UI `focusableWhenDisabled`) — for tooltips on disabled controls. */
		focusableWhenDisabled?: boolean;
		ref?: HTMLElement | null;
		children?: Snippet;
	};
	type Props = Common &
		(
			| (Omit<HTMLButtonAttributes, 'type'> & {
					href?: undefined;
					type?: 'button' | 'submit' | 'reset';
			  })
			| (HTMLAnchorAttributes & { href: string; disabled?: boolean })
		);

	let {
		variant,
		size,
		shape,
		block,
		casing,
		focusableWhenDisabled = false,
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Props = $props();

	if (dev && variant === 'accent' && !isIconSize(size)) {
		console.warn(
			'[alpha-ds] Button variant="accent" is icon-button scale only (spec: accent is never a surface fill). Use size="icon*".'
		);
	}

	const classes = $derived(cn(buttonRecipe({ variant, size, shape, block, casing }), className));
	const disabled = $derived(Boolean((rest as { disabled?: boolean }).disabled));
</script>

{#if rest.href !== undefined}
	{@const { disabled: _disabled, ...anchor } = rest as HTMLAnchorAttributes & {
		disabled?: boolean;
	}}
	<a
		bind:this={ref}
		{...anchor}
		class={classes}
		aria-disabled={disabled || undefined}
		data-disabled={disabled ? '' : undefined}
		tabindex={disabled ? -1 : anchor.tabindex}
	>
		{@render children?.()}
	</a>
{:else}
	{@const button = rest as HTMLButtonAttributes}
	<button
		bind:this={ref}
		type="button"
		{...button}
		class={classes}
		disabled={disabled && !focusableWhenDisabled}
		aria-disabled={disabled && focusableWhenDisabled ? true : undefined}
		data-disabled={disabled ? '' : undefined}
	>
		{@render children?.()}
	</button>
{/if}
