<!--
  @component
  Base UI `Menu.Group` (engine: bits-ui DropdownMenu.Group).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuGroupProps } from 'bits-ui';

	let { children, ...rest }: DropdownMenuGroupProps = $props();
</script>

<Engine.Group {...rest}>{@render children?.()}</Engine.Group>
