<!--
  @component
  Base UI `Slider.Indicator` (engine: bits-ui Slider.Range) — the filled portion.
-->
<script lang="ts">
	import { Slider as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<Engine.Range class={cn('absolute h-full bg-fg-1', className)} />
