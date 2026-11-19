<script lang="ts">
	// Test-only: two sheets, controls outside them, and a readout of useSheetOpen(). Not used by any
	// route or catalog page. The controls are driven with element.click(), which the open sheet's
	// pointer lock does not stop.
	import { Sheet, useSheetOpen } from './index.ts';

	let a = $state(false);
	let b = $state(false);
	let mountA = $state(true);
	const sheetOpen = useSheetOpen();
</script>

<output data-sheet-open={sheetOpen.current ? 'yes' : 'no'}></output>
<button type="button" data-toggle="a" onclick={() => (a = !a)}>A</button>
<button type="button" data-toggle="b" onclick={() => (b = !b)}>B</button>
<button type="button" data-toggle="mount-a" onclick={() => (mountA = !mountA)}>Mount A</button>
{#if mountA}
	<Sheet.Root bind:open={a}>
		<Sheet.Portal>
			<Sheet.Popup aria-label="Sheet A">
				<Sheet.Header title="Sheet A" />
				<Sheet.Body>A</Sheet.Body>
			</Sheet.Popup>
		</Sheet.Portal>
	</Sheet.Root>
{/if}
<Sheet.Root bind:open={b}>
	<Sheet.Portal>
		<Sheet.Popup aria-label="Sheet B">
			<Sheet.Header title="Sheet B" />
			<Sheet.Body>B</Sheet.Body>
		</Sheet.Popup>
	</Sheet.Portal>
</Sheet.Root>
