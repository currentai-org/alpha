<script lang="ts">
	import { Meter } from '@aipotluck/alpha-ds';
</script>

<Meter.Root value={0.42} max={1} format={(v) => `${v.toFixed(2)} Wh`} class="max-w-sm">
	<Meter.Label>You consumed</Meter.Label>
	<Meter.Value />
	<Meter.Track><Meter.Indicator tone="accent" /></Meter.Track>
</Meter.Root>
