<script lang="ts">
	import { Inline, Toggle } from '@aipotluck/alpha-ds';
	import RiGlobalLine from '~icons/ri/global-line';
	import RiVolumeUpLine from '~icons/ri/volume-up-line';
	import RiBold from '~icons/ri/bold';
	let search = $state(true);
	let speak = $state(false);
	let bold = $state(false);
</script>

<Inline gap="2">
	<Toggle bind:pressed={search}><RiGlobalLine /> Web search</Toggle>
	<Toggle bind:pressed={speak}><RiVolumeUpLine /> Read aloud</Toggle>
	<Toggle variant="tile" bind:pressed={bold} aria-label="Bold"><RiBold /></Toggle>
</Inline>
