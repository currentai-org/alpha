<!--
  @component
  Base UI `Menu.Popup` (engine: bits-ui DropdownMenu.Content, or SubContent inside a submenu).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { popupRecipe } from '../../internal/popup.recipe.ts';
	import { getPositioner } from '../../internal/positioner.ts';
	import { getContext } from 'svelte';
	import { SUBMENU } from './submenu.ts';

	let {
		class: className,
		children,
		...rest
	}: Omit<DropdownMenuContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> = $props();

	// Inside Menu.SubmenuRoot this is the flyout; the engine positions it beside its trigger.
	const sub = getContext<boolean | undefined>(SUBMENU) === true;
	// A flyout is offset from its trigger ROW, which sits inside the parent's 4px padding + 1px border:
	// 4 + 1 + 4 = a 4px gap from the parent menu's edge; -5 aligns its first row with the trigger.
	const position = getPositioner(
		sub ? { sideOffset: 9, alignOffset: -5, align: 'start' } : { align: 'start' }
	);
	// Never taller than the room the positioner found (bits-ui's --bits-floating-available-height), so
	// a long menu scrolls instead of running off the screen, as Select's popup already does. The rows
	// scroll inside an inner region whose edges fade while there is more to scroll, so a row cut by the
	// edge reads as "more below" rather than as clipped text (CUR-2351). The fade sits on the inner
	// region because its mask and scroll-driven animation would otherwise clip the popup's offset
	// shadow and replace its open/close animation.
	const classes = $derived(
		cn(
			popupRecipe({ padded: false }),
			'flex min-w-48 max-h-(--bits-floating-available-height) flex-col',
			className
		)
	);
	const scrollClass = 'min-h-0 overflow-y-auto scroll-fade-y p-1';
</script>

{#if sub}
	<Engine.SubContent
		sideOffset={position.sideOffset}
		alignOffset={position.alignOffset}
		collisionPadding={position.collisionPadding}
		{...rest}
		data-surface="3"
		class={classes}
	>
		<div class={scrollClass} data-menu-scroll>{@render children?.()}</div>
	</Engine.SubContent>
{:else}
	<Engine.Content {...position} {...rest} data-surface="3" class={classes}>
		<div class={scrollClass} data-menu-scroll>{@render children?.()}</div>
	</Engine.Content>
{/if}
