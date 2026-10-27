<!--
  @component
  Base UI `Slider.Thumb` (engine: bits-ui Slider.Thumb) — square, sharp.
-->
<script lang="ts">
	import { Slider as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { index = 0, class: className }: { index?: number; class?: string } = $props();
</script>

<Engine.Thumb
	{index}
	class={cn(
		'block size-3.5 rounded-sharp border-2 border-fg-1 bg-surface-1 transition-control hover:bg-fg-1',
		className
	)}
/>
