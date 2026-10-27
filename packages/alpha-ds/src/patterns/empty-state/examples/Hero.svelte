<script lang="ts">
	import { Composer, EmptyState, EmptyStateSuggestion } from '@aipotluck/alpha-ds';
	let value = $state('');
	const prompts = [
		'Which open models speak Swahili?',
		'Where do gaps in open source AI sit?',
		'Explain Apertus in one paragraph'
	];
</script>

<EmptyState
	title="Make AI yours."
	description="Talk in your language, see which AI answered and where it ran."
>
	<Composer.Root bind:value>
		<Composer.Input />
		<Composer.Toolbar><Composer.Tools /><Composer.Send /></Composer.Toolbar>
	</Composer.Root>
	{#snippet suggestions()}
		{#each prompts as p (p)}<EmptyStateSuggestion onclick={() => (value = p)}
				>{p}</EmptyStateSuggestion
			>{/each}
	{/snippet}
</EmptyState>
