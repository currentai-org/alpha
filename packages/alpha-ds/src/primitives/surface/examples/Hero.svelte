<script lang="ts">
	import { Button, Grid, Surface } from '@aipotluck/alpha-ds';
</script>

<Grid cols={3} gap="4">
	{#each ['1', '2', '3'] as const as level (level)}
		<Surface {level} border="auto" padding="md" class="flex flex-col gap-3">
			<span class="type-label text-fg-3">Background {level}</span>
			<Button>Rests one tier up</Button>
		</Surface>
	{/each}
</Grid>
