<!--
  @component
  Base UI `AlertDialog.Root` (engine: bits-ui AlertDialog.Root) — a dialog that requires a
  decision; outside clicks do not dismiss it.
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogRootProps } from 'bits-ui';

	let { open = $bindable(false), children, ...rest }: AlertDialogRootProps = $props();
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
