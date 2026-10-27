<script lang="ts">
	import { Stack } from '@aipotluck/alpha-ds';
</script>

<Stack gap="0" divided class="max-w-xs border-y border-line-2">
	{#each ['Account', 'Appearance', 'Data & privacy'] as item (item)}
		<span class="py-3 type-body">{item}</span>
	{/each}
</Stack>
