<!--
  @component
  Base UI `Popover.Root` (engine: bits-ui Popover.Root).
-->
<script lang="ts">
	import { Popover as Engine, type PopoverRootProps } from 'bits-ui';

	let { open = $bindable(false), children, ...rest }: PopoverRootProps = $props();
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
