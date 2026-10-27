<!--
  @component
  Base UI `Menu.RadioGroup` (engine: bits-ui DropdownMenu.RadioGroup).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuRadioGroupProps } from 'bits-ui';

	let { value = $bindable(''), children, ...rest }: DropdownMenuRadioGroupProps = $props();
</script>

<Engine.RadioGroup bind:value {...rest}>{@render children?.()}</Engine.RadioGroup>
