<!--
  @component
  Shared `Positioner` part for every floating component (Popover, Tooltip, Menu, Select,
  PreviewCard). Records placement for the `Popup` inside it; renders no element of its own.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setPositioner, type PositionerProps } from './positioner.ts';

	let { children, ...position }: PositionerProps & { children?: Snippet } = $props();
	setPositioner(() => position);
</script>

{@render children?.()}
