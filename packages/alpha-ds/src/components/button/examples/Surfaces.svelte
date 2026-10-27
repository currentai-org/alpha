<script lang="ts">
	import { Button, Surface, Grid } from '@aipotluck/alpha-ds';
</script>

<!-- A bordered button's rest fill is one tier up from whatever it sits on — automatically. -->
<Grid cols={3} gap="3">
	{#each ['1', '2', '3'] as const as level (level)}
		<Surface {level} border="auto" padding="md" class="flex flex-col gap-3">
			<span class="type-label text-fg-3">Background {level}</span>
			<Button>Secondary</Button>
		</Surface>
	{/each}
</Grid>
