<script lang="ts">
	import { Accordion } from '@aipotluck/alpha-ds';
	let value = $state(['sources']);
</script>

<Accordion.Root multiple bind:value class="max-w-lg">
	<Accordion.Item value="sources">
		<Accordion.Header><Accordion.Trigger>Sources</Accordion.Trigger></Accordion.Header>
		<Accordion.Panel>Three web results and one catalog entry grounded this answer.</Accordion.Panel>
	</Accordion.Item>
	<Accordion.Item value="reasoning">
		<Accordion.Header><Accordion.Trigger>Reasoning</Accordion.Trigger></Accordion.Header>
		<Accordion.Panel>The model compared release dates before answering.</Accordion.Panel>
	</Accordion.Item>
</Accordion.Root>
