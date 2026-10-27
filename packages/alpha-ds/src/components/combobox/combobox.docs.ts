import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'combobox',
	name: 'Combobox',
	layer: 'component',
	description:
		'Choose one value from a list you can type to search, with fuzzy matching that forgives typos and accents.',
	keywords: ['autocomplete', 'searchable select', 'typeahead', 'fuzzy search', 'language picker'],
	baseUi: { name: 'Combobox', url: 'https://base-ui.com/react/components/combobox' },
	deviations: [
		'`Trigger` and `Icon` are folded into `Input`: the chevron sits inside the field.',
		'Filtering is yours: rank items with `fuzzyFilter(items, query)` and render what it returns.',
		'`Empty` is rendered by the consumer when the filtered list is empty.',
		'Single-select only.'
	],
	anatomy: `<Combobox.Root items={items} inputValue={selectedLabel}>
  <Combobox.Input oninput={(e) => (query = e.currentTarget.value)} />
  <Combobox.Portal>
    <Combobox.Positioner>
      <Combobox.Popup>
        {#each fuzzyFilter(items, query) as item}
          <Combobox.Item value={item.value} label={item.label} />
        {:else}
          <Combobox.Empty>No matches</Combobox.Empty>
        {/each}
      </Combobox.Popup>
    </Combobox.Positioner>
  </Combobox.Portal>
</Combobox.Root>`,
	parts: [
		{
			name: 'Combobox.Root',
			description: '',
			engine: 'bits-ui Combobox.Root',
			props: [
				{ name: 'value', type: 'string', description: 'Bindable.' },
				{ name: 'open', type: 'boolean', description: 'Bindable.' },
				{
					name: 'items',
					type: '{ value, label, disabled? }[]',
					description: 'Every item, not just the filtered ones.'
				},
				{
					name: 'inputValue',
					type: 'string',
					description: 'What the input shows when nobody is typing, usually the selected label.'
				},
				{ name: 'name / required / disabled', type: '', description: 'Form participation.' }
			]
		},
		{
			name: 'Combobox.Input',
			description:
				'Input skin with the chevron inside; joins a Field. Clicking it opens the list, as a Select would.',
			engine: 'bits-ui Combobox.Input + Combobox.Trigger',
			props: [
				{ name: 'placeholder', type: 'string', description: '' },
				{
					name: 'triggerLabel',
					type: 'string',
					default: "'Show options'",
					description: 'Accessible name of the chevron button.'
				}
			],
			dataAttributes: [{ name: 'data-state=open', description: '' }]
		},
		{
			name: 'Combobox.Positioner',
			description: 'Placement, as for Select.'
		},
		{
			name: 'Combobox.Popup',
			description: 'List; at least input width, at most 20rem tall, fading at the edge with more.',
			engine: 'bits-ui Combobox.Content'
		},
		{
			name: 'Combobox.Item',
			description: 'Option; draws its check.',
			engine: 'bits-ui Combobox.Item',
			props: [
				{ name: 'value', type: 'string', description: '' },
				{ name: 'label', type: 'string', description: 'What the input shows once picked.' }
			],
			dataAttributes: [
				{ name: 'data-highlighted', description: '' },
				{ name: 'data-selected', description: '' }
			]
		},
		{ name: 'Combobox.Empty', description: 'The no-matches line.' },
		{
			name: 'Combobox.Separator',
			description: 'Sets off an item that always shows, below the matches.'
		}
	],
	guidelines: {
		do: [
			'Use it over Select once a list is long enough that people look for one entry by name (languages, countries).',
			'Give items `keywords` for the other names people search by: an English name, an endonym, a code.',
			'Keep an escape hatch such as “My language isn’t listed” below a Separator, outside the filtered list, so a search never hides it.'
		],
		dont: ['Filter inside the engine: pass every item to Root and render only the matches.']
	},
	examples: [{ file: 'Hero', title: 'Language picker' }]
} satisfies DocEntry;
