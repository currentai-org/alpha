<!--
  @component
  Base UI `Tooltip.Provider` (engine: bits-ui Tooltip.Provider) — shares open delays so moving
  between triggers feels instant. ThemeProvider already mounts one; nest another only to change delays for a region.
-->
<script lang="ts">
	import { Tooltip as Engine, type TooltipProviderProps } from 'bits-ui';

	let {
		delayDuration = 500,
		skipDelayDuration = 300,
		children,
		...rest
	}: TooltipProviderProps = $props();
</script>

<Engine.Provider {delayDuration} {skipDelayDuration} {...rest}
	>{@render children?.()}</Engine.Provider
>
