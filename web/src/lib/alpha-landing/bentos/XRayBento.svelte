<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiScan2Line from '~icons/ri/scan-2-line';
	import PictureBento from './PictureBento.svelte';
</script>

<PictureBento
	name="xray"
	icon={RiScan2Line}
	title={m.welcome_xrayTitle()}
	body={m.welcome_xrayBody()}
/>
