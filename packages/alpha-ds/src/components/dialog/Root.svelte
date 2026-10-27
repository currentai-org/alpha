<!--
  @component
  Base UI `Dialog.Root` (engine: bits-ui Dialog.Root).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogRootProps } from 'bits-ui';

	let { open = $bindable(false), children, ...rest }: DialogRootProps = $props();
</script>

<Engine.Root bind:open {...rest}>{@render children?.()}</Engine.Root>
