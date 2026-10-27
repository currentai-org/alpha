<!--
  @component
  Base UI `Switch.Thumb` (engine: bits-ui Switch.Thumb).
-->
<script lang="ts">
	import { Switch as Engine } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { class: className }: { class?: string } = $props();
</script>

<Engine.Thumb
	class={cn(
		'pointer-events-none block size-3.5 rounded-sharp bg-fg-2 transition-[translate,background-color] duration-(--ds-duration-fast) ease-standard',
		'ui-checked:translate-x-4 ui-checked:bg-surface-1',
		className
	)}
/>
