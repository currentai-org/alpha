<script lang="ts">
	import { Tabs } from '@aipotluck/alpha-ds';

	let { labels }: { labels: string[] } = $props();
	let value = $state('0');
</script>

<!-- A column as narrow as the Files page's on a laptop, so a handful of linked places overflows one row. -->
<div style="width: 420px">
	<Tabs.Root bind:value variant="segment" class="gap-3">
		<Tabs.List aria-label="Storage location">
			{#each labels as label, i (label)}
				<Tabs.Tab value={String(i)}>{label}</Tabs.Tab>
			{/each}
		</Tabs.List>
	</Tabs.Root>
</div>
