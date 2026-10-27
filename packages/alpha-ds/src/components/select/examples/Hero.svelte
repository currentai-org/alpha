<script lang="ts">
	import { Field, Select } from '@aipotluck/alpha-ds';

	const models = [
		{ value: 'apertus-70b', label: 'Apertus 70B' },
		{ value: 'apertus-8b', label: 'Apertus 8B' },
		{ value: 'olmo-2', label: 'OLMo 2' }
	];
	let model = $state('apertus-70b');
</script>

<Field.Root class="max-w-xs">
	<Field.Label>Model</Field.Label>
	<Select.Root bind:value={model} items={models}>
		<Select.Trigger>
			<Select.Value />
			<Select.Icon />
		</Select.Trigger>
		<Select.Portal>
			<Select.Positioner>
				<Select.Popup>
					{#each models as m (m.value)}
						<Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
					{/each}
				</Select.Popup>
			</Select.Positioner>
		</Select.Portal>
	</Select.Root>
</Field.Root>
