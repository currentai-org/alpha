<!--
  @component
  Base UI `PreviewCard.Root` (engine: bits-ui LinkPreview.Root) — hover/focus a trigger to reveal
  supplementary detail. This is the spec's footprint "progressive disclosure" pattern.
-->
<script lang="ts">
	import { LinkPreview as Engine, type LinkPreviewRootProps } from 'bits-ui';

	let {
		open = $bindable(false),
		delay = 300,
		closeDelay = 150,
		children,
		...rest
	}: Omit<LinkPreviewRootProps, 'openDelay'> & { delay?: number } = $props();
</script>

<Engine.Root bind:open openDelay={delay} {closeDelay} {...rest}>{@render children?.()}</Engine.Root>
