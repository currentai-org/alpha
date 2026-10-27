<script lang="ts">
	import { Stack, Switch } from '@aipotluck/alpha-ds';
	let search = $state(true);
	let haptics = $state(false);
</script>

<Stack gap="3" class="max-w-sm">
	<label class="flex items-center justify-between gap-4 type-body">
		Web search
		<Switch.Root bind:checked={search}><Switch.Thumb /></Switch.Root>
	</label>
	<label class="flex items-center justify-between gap-4 type-body">
		Haptic feedback
		<Switch.Root bind:checked={haptics}><Switch.Thumb /></Switch.Root>
	</label>
</Stack>
