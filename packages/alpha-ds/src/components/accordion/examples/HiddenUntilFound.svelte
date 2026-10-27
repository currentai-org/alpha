<script lang="ts">
	import { Accordion } from '@aipotluck/alpha-ds';
</script>

<!-- Closed panels stay searchable: Ctrl/⌘+F finds “public infrastructure” and opens its panel. -->
<Accordion.Root class="max-w-lg">
	<Accordion.Item value="where">
		<Accordion.Header><Accordion.Trigger>Where does Alpha run?</Accordion.Trigger></Accordion.Header
		>
		<Accordion.Panel hiddenUntilFound>On public infrastructure, not a hyperscaler.</Accordion.Panel>
	</Accordion.Item>
</Accordion.Root>
