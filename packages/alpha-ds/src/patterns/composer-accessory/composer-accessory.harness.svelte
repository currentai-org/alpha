<script lang="ts">
	// Test-only: a composer docked to the bottom of a fixed-height column (the chat's composer band)
	// with two panels of different heights. Not used by any route or catalog page.
	import { ComposerAccessory } from '../../index.ts';

	let { open = $bindable(null) }: { open?: string | null } = $props();
</script>

<div
	style="display:flex; flex-direction:column; justify-content:flex-end; width:640px; height:720px"
>
	<ComposerAccessory.Root bind:open>
		<ComposerAccessory.Panel value="short" label="Short panel">
			<div style="height:120px">Short</div>
		</ComposerAccessory.Panel>
		<ComposerAccessory.Panel value="tall" label="Tall panel">
			<div style="height:360px">Tall</div>
		</ComposerAccessory.Panel>
		<div style="height:80px">Composer</div>
		<ComposerAccessory.Row>
			<ComposerAccessory.Pill value="short">Short</ComposerAccessory.Pill>
			<ComposerAccessory.Pill value="tall">Tall</ComposerAccessory.Pill>
		</ComposerAccessory.Row>
	</ComposerAccessory.Root>
</div>
