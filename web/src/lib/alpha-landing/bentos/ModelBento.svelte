<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiCpuLine from '~icons/ri/cpu-line';
	import PictureBento from './PictureBento.svelte';
</script>

<PictureBento
	name="model"
	icon={RiCpuLine}
	title={m.welcome_modelTitle()}
	body={m.welcome_modelBody()}
/>
