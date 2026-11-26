<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import { GUEST_RETENTION_DAYS } from '../chatFacts';
	import PictureBento from './PictureBento.svelte';
</script>

<PictureBento
	name="data"
	icon={RiShieldCheckLine}
	title={m.welcome_dataTitle()}
	body={m.welcome_dataBodyGuest({
		days: GUEST_RETENTION_DAYS,
		// The landing is www's own page, so it names who runs www.
		organisation: 'Current AI'
	})}
/>
