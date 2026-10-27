<!--
  @component
  Base UI `Menu.SubmenuRoot` (engine: bits-ui DropdownMenu.Sub). A nested menu: put a
  `Menu.SubmenuTrigger` and a `Menu.Portal > Menu.Positioner > Menu.Popup` inside — the Popup knows
  it is a submenu and flies out to the side.
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuSubProps } from 'bits-ui';
	import { setContext } from 'svelte';
	import { SUBMENU } from './submenu.ts';

	let { open = $bindable(false), children, ...rest }: DropdownMenuSubProps = $props();
	setContext(SUBMENU, true);
</script>

<Engine.Sub bind:open {...rest}>{@render children?.()}</Engine.Sub>
