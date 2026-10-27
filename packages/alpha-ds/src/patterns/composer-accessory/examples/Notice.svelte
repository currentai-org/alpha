<script lang="ts">
	import { Button, Composer, ComposerAccessory } from '@aipotluck/alpha-ds';
	import RiImageLine from '~icons/ri/image-line';
	let value = $state('');
	let shown = $state(true);
</script>

<div class="w-full max-w-thread">
	<ComposerAccessory.Root>
		{#if shown}
			<ComposerAccessory.Notice icon={RiImageLine} ondismiss={() => (shown = false)}>
				Apertus 1.5 70B can’t read photos, so it won’t see the one attached.
				{#snippet action()}<Button
						variant="ghost"
						size="sm"
						casing="sentence"
						onclick={() => (shown = false)}>Remove photo</Button
					>{/snippet}
			</ComposerAccessory.Notice>
		{/if}
		<Composer.Root bind:value>
			<Composer.Input />
			<Composer.Toolbar><Composer.Send /></Composer.Toolbar>
		</Composer.Root>
	</ComposerAccessory.Root>
	{#if !shown}<Button variant="secondary" size="sm" class="mt-3" onclick={() => (shown = true)}
			>Show notice</Button
		>{/if}
</div>
