<!--
  @component
  Base UI `PreviewCard.Popup` (engine: bits-ui LinkPreview.Content). `inverse` renders the spec's
  one deliberate light-on-dark flip (the footprint hover card) by flipping `data-mode` for its
  subtree — every token inside re-resolves for the opposite mode.
-->
<script lang="ts">
	import { LinkPreview as Engine, type LinkPreviewContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { popupRecipe } from '../../internal/popup.recipe.ts';
	import { getPositioner } from '../../internal/positioner.ts';
	import { getThemeContext } from '../../theme/context.ts';

	let {
		inverse = false,
		class: className,
		children,
		...rest
	}: Omit<LinkPreviewContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> & {
		inverse?: boolean;
	} = $props();

	const position = getPositioner({ sideOffset: 8 });
	const theme = getThemeContext();
	const flipped = $derived(theme?.resolvedMode === 'dark' ? 'light' : 'dark');
</script>

<Engine.Content
	{...position}
	{...rest}
	data-surface="3"
	data-mode={inverse ? flipped : undefined}
	class={cn(popupRecipe({ size: 'md' }), className)}
>
	{@render children?.()}
</Engine.Content>
