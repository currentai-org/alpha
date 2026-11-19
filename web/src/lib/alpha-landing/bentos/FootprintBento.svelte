<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiLeafLine from '~icons/ri/leaf-line';
	import PictureBento from './PictureBento.svelte';
</script>

<PictureBento
	name="footprint"
	icon={RiLeafLine}
	title={m.welcome_energyTitle()}
	body={m.welcome_energyBody()}
/>
