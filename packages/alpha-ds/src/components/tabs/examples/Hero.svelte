<script lang="ts">
	import { Tabs } from '@aipotluck/alpha-ds';
	let value = $state('model');
</script>

<Tabs.Root bind:value class="max-w-lg">
	<Tabs.List>
		<Tabs.Tab value="model">Model</Tabs.Tab>
		<Tabs.Tab value="compute">Compute</Tabs.Tab>
		<Tabs.Tab value="data">Data</Tabs.Tab>
	</Tabs.List>
	<Tabs.Panel value="model"
		><p class="type-body text-fg-2">Apertus 70B — open weights, open data.</p></Tabs.Panel
	>
	<Tabs.Panel value="compute"
		><p class="type-body text-fg-2">Served from public-interest compute.</p></Tabs.Panel
	>
	<Tabs.Panel value="data"
		><p class="type-body text-fg-2">Training data documented per source.</p></Tabs.Panel
	>
</Tabs.Root>
