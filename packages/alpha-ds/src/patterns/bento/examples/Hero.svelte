<script lang="ts">
	import RiContrast2Line from '~icons/ri/contrast-2-line';
	import RiTranslate2 from '~icons/ri/translate-2';
	import { Badge, BentoTile, Inline, Switch } from '@aipotluck/alpha-ds';

	let dark = $state(false);
	const languages = ['English', 'Deutsch', 'Français', 'Italiano', 'Rumantsch', 'Kiswahili'];
</script>

<div class="grid gap-4 md:grid-cols-2">
	<BentoTile
		compact
		icon={RiTranslate2}
		title="Speaks your language"
		body="Trained on more than a thousand languages."
	>
		<Inline gap="2" class="justify-center">
			{#each languages as l (l)}<Badge>{l}</Badge>{/each}
		</Inline>
	</BentoTile>
	<BentoTile compact icon={RiContrast2Line} title="Yours to shape" body="Light, dark, or your own.">
		<label class="flex items-center gap-3 type-caption text-fg-2">
			<Switch.Root bind:checked={dark}><Switch.Thumb /></Switch.Root>
			{dark ? 'Dark' : 'Light'}
		</label>
	</BentoTile>
</div>
