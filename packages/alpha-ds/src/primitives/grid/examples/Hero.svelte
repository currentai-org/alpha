<script lang="ts">
	import { Grid } from '@aipotluck/alpha-ds';
	const layers = ['Model', 'Compute', 'Data', 'Safety', 'Search', 'Interface'];
</script>

<Grid min="10rem" ruled>
	{#each layers as layer (layer)}
		<div class="flex flex-col gap-1 p-4">
			<span class="type-label text-fg-3">Layer</span>
			<span class="type-title">{layer}</span>
		</div>
	{/each}
</Grid>
