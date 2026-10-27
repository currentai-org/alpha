<script lang="ts">
	import { Radio, RadioGroup } from '@aipotluck/alpha-ds';
	let mode = $state('system');
</script>

<RadioGroup bind:value={mode} aria-label="Colour mode">
	{#each ['light', 'dark', 'system'] as option (option)}
		<label class="flex items-center gap-2 type-body capitalize">
			<Radio.Root value={option}><Radio.Indicator /></Radio.Root>
			{option}
		</label>
	{/each}
</RadioGroup>
