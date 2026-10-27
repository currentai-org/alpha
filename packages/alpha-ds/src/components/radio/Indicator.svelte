<!--
  @component
  Base UI `Radio.Indicator` — the inner mark, visible when its radio is checked. Its corner is
  concentric with the radio's (the theme's Radius 1, less the 4px inset), so it follows the theme:
  a square mark in a square radio, a round dot once a large radius has made the radio a circle.
-->
<script lang="ts">
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<span
	class={cn(
		'hidden size-2 rounded-[max(0px,calc(var(--radius-sharp)-4px))] bg-fg-1 group-ui-checked/radio:block',
		className
	)}
></span>
