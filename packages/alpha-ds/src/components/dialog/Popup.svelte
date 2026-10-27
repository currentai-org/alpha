<!--
  @component
  Base UI `Dialog.Popup` (engine: bits-ui Dialog.Content). Centred, Background 3, brutalist frame.
-->
<script lang="ts">
	import { Dialog as Engine, type DialogContentProps } from 'bits-ui';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';

	const dialogRecipe = tv({
		base: [
			'fixed left-1/2 z-overlay flex w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-y-auto',
			'border border-line-2 bg-surface-3 text-fg-1 shadow-popover rounded-sharp outline-none motion-dialog'
		],
		variants: {
			/** `full`: only the viewport inset caps it — for callers that size the popup themselves. */
			size: { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', full: 'max-w-none' },
			/** `top`: anchored near the top (command palettes), so results grow downward. It is capped
			 *  at the space below that anchor, so a tall popup scrolls inside the window, not past it. */
			placement: {
				center: 'top-1/2 max-h-[calc(100dvh-2rem)] -translate-y-1/2',
				top: 'top-[12vh] max-h-[calc(100dvh-12vh-1rem)]'
			},
			/** `false`: no inner padding or gap — the content lays itself out (palettes, lists). */
			padded: { true: 'gap-4 p-6', false: 'gap-0 p-0' }
		},
		defaultVariants: { size: 'md', placement: 'center', padded: true }
	});

	let {
		size,
		placement,
		padded,
		class: className,
		children,
		...rest
	}: DialogContentProps & VariantProps<typeof dialogRecipe> = $props();
</script>

<Engine.Content
	{...rest}
	data-surface="3"
	class={cn(dialogRecipe({ size, placement, padded }), className)}
>
	{@render children?.()}
</Engine.Content>
