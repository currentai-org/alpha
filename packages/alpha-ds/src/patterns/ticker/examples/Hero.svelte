<script lang="ts">
	import { Ticker } from '@aipotluck/alpha-ds';

	const rows = [
		{ name: 'ALIA 40B', line: 'Barcelona Supercomputing Center · runs on NextBit' },
		{ name: 'Apertus 1.5 70B', line: 'Swiss AI Initiative · runs on Infomaniak' },
		{ name: 'Bielik 11B v3', line: 'SpeakLeash' }
	];
</script>

<div class="flex w-64 flex-col">
	{#each rows as row (row.name)}
		<button
			type="button"
			class="flex w-full min-w-0 flex-col rounded-sharp px-3 py-2 text-left transition-control hover:bg-tint-subtle"
		>
			<span class="truncate type-body text-fg-1">{row.name}</span>
			<span class="min-w-0 type-caption text-fg-3"><Ticker>{row.line}</Ticker></span>
		</button>
	{/each}
</div>
