<script lang="ts">
	import { Toggle, ToggleGroup } from '@aipotluck/alpha-ds';
	let value = $state(['dark']);
</script>

<ToggleGroup bind:value aria-label="Mode">
	<Toggle value="light">Light</Toggle>
	<Toggle value="dark">Dark</Toggle>
	<Toggle value="system">System</Toggle>
</ToggleGroup>
