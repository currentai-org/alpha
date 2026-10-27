<!--
  @component
  Base UI `Select.Group` (engine: bits-ui Select.Group).
-->
<script lang="ts">
	import { Select as Engine, type SelectGroupProps } from 'bits-ui';

	let { children, ...rest }: SelectGroupProps = $props();
</script>

<Engine.Group {...rest}>{@render children?.()}</Engine.Group>
