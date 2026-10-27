<!--
  @component
  Base UI `Meter.Root` — a measurement within a known range (energy used, context window), as
  opposed to Progress (task completion). Shares Progress's parts.
-->
<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import ProgressRoot from '../progress/Root.svelte';

	let { children, ...rest }: Omit<ComponentProps<typeof ProgressRoot>, 'role'> = $props();
</script>

<ProgressRoot role="meter" {...rest}>{@render children?.()}</ProgressRoot>
