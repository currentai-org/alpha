<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiTranslate2 from '~icons/ri/translate-2';
	import PictureBento from './PictureBento.svelte';
</script>

<PictureBento
	name="language"
	icon={RiTranslate2}
	title={m.welcome_languageTitle()}
	body={m.welcome_languageBody()}
/>
