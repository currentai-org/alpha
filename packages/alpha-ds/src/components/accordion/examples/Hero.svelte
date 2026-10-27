<script lang="ts">
	import { Accordion } from '@aipotluck/alpha-ds';

	const faq = [
		{
			q: 'Which model answers?',
			a: 'Apertus, served through an open gateway. Every answer names the model that served it.'
		},
		{
			q: 'Where does it run?',
			a: 'Public-interest compute in Switzerland. Open the XRAY view to see the full stack.'
		},
		{
			q: 'What is stored?',
			a: 'Only what you keep. “Forget everything” removes conversations, settings and contributions.'
		}
	];
</script>

<Accordion.Root class="max-w-lg">
	{#each faq as item (item.q)}
		<Accordion.Item value={item.q}>
			<Accordion.Header>
				<Accordion.Trigger>{item.q}</Accordion.Trigger>
			</Accordion.Header>
			<Accordion.Panel>{item.a}</Accordion.Panel>
		</Accordion.Item>
	{/each}
</Accordion.Root>
