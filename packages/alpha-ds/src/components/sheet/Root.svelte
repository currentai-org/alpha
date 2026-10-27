<!--
  @component
  `Sheet.Root` — a mobile-native bottom sheet (engine: bits-ui Dialog, so focus trap, Escape and
  scroll lock come for free). Alpha-only: Base UI has no sheet. Use `useCompact()` to show a sheet on
  small screens and your desktop surface (Popover, Panel, Dialog) otherwise.
-->
<script lang="ts">
	import { Dialog as Engine, type DialogRootProps } from 'bits-ui';
	import { setSheet } from './context.ts';

	let { open = $bindable(false), children, ...rest }: DialogRootProps = $props();
	setSheet({
		close() {
			open = false;
		}
	});
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
