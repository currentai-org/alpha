<script lang="ts">
	import { Tabs } from '@aipotluck/alpha-ds';
	let value = $state('alpha');
</script>

<Tabs.Root bind:value variant="segment" class="max-w-lg gap-3">
	<Tabs.List aria-label="Storage location">
		<Tabs.Tab value="alpha">Alpha storage <span class="type-caption opacity-70">12</span></Tabs.Tab>
		<Tabs.Tab value="bucket"
			>someone/alpha-files <span class="type-caption opacity-70">3</span></Tabs.Tab
		>
	</Tabs.List>
	<Tabs.Panel value="alpha"
		><p class="type-body text-fg-2">Files held in Alpha storage.</p></Tabs.Panel
	>
	<Tabs.Panel value="bucket"
		><p class="type-body text-fg-2">Files in a bucket you linked.</p></Tabs.Panel
	>
</Tabs.Root>
