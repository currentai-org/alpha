<!--
  @component
  Base UI `Tooltip.Root` (engine: bits-ui Tooltip.Root). Needs a `Tooltip.Provider` ancestor —
  every ThemeProvider mounts one, so inside the design system this is automatic.
-->
<script lang="ts">
	import { Tooltip as Engine, type TooltipRootProps } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		children,
		...rest
	}: Omit<TooltipRootProps, 'children'> & { children?: Snippet } = $props();
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
