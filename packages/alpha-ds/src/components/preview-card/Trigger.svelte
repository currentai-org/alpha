<!--
  @component
  Base UI `PreviewCard.Trigger` (engine: bits-ui LinkPreview.Trigger). Usually wraps an existing
  element via `child`.
-->
<script lang="ts">
	import { LinkPreview as Engine, type LinkPreviewTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children, ...rest }: LinkPreviewTriggerProps = $props();
</script>

<Engine.Trigger {...rest} class={cn(className)}>{@render children?.()}</Engine.Trigger>
