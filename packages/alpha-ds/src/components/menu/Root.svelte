<!--
  @component
  Base UI `Menu.Root` (engine: bits-ui DropdownMenu.Root).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuRootProps } from 'bits-ui';

	let { open = $bindable(false), children, ...rest }: DropdownMenuRootProps = $props();
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
