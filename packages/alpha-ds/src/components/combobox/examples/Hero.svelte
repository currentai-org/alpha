<script lang="ts">
	import { Combobox, Field, fuzzyFilter } from '@aipotluck/alpha-ds';

	const languages = [
		{ value: 'cat', label: 'Catalan', keywords: ['català'] },
		{ value: 'eus', label: 'Basque', keywords: ['euskara'] },
		{ value: 'pol', label: 'Polish', keywords: ['polski'] },
		{ value: 'swh', label: 'Swahili', keywords: ['kiswahili'] },
		{ value: 'yor', label: 'Yoruba', keywords: ['yorùbá'] }
	];
	const OTHER = 'other';
	const items = [...languages, { value: OTHER, label: 'My language isn’t listed' }];

	let value = $state('cat');
	let query = $state('');
	const matches = $derived(fuzzyFilter(languages, query));
	const selected = $derived(items.find((item) => item.value === value)?.label ?? '');
</script>

<Field.Root class="max-w-xs">
	<Field.Label>Language</Field.Label>
	<Combobox.Root
		bind:value
		{items}
		inputValue={selected}
		onOpenChange={(open) => {
			if (!open) query = '';
		}}
	>
		<Combobox.Input
			placeholder="Search languages"
			oninput={(e) => (query = e.currentTarget.value)}
		/>
		<Combobox.Portal>
			<Combobox.Positioner>
				<Combobox.Popup>
					{#each matches as language (language.value)}
						<Combobox.Item value={language.value} label={language.label} />
					{:else}
						<Combobox.Empty>No languages match</Combobox.Empty>
					{/each}
					<Combobox.Separator />
					<Combobox.Item value={OTHER} label="My language isn’t listed" />
				</Combobox.Popup>
			</Combobox.Positioner>
		</Combobox.Portal>
	</Combobox.Root>
</Field.Root>
