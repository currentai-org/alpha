<script lang="ts">
	import { Checkbox, Stack } from '@aipotluck/alpha-ds';
	let a = $state(true);
	let b = $state(false);
</script>

<Stack gap="3">
	<label class="flex items-center gap-2 type-body">
		<Checkbox.Root bind:checked={a}><Checkbox.Indicator /></Checkbox.Root>
		Remember this device
	</label>
	<label class="flex items-center gap-2 type-body">
		<Checkbox.Root bind:checked={b}><Checkbox.Indicator /></Checkbox.Root>
		Contribute anonymised transcripts
	</label>
	<label class="flex items-center gap-2 type-body">
		<Checkbox.Root indeterminate><Checkbox.Indicator /></Checkbox.Root>
		Some sources selected
	</label>
</Stack>
