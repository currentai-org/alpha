<script lang="ts">
	import { brandOf } from "$lib/chat/brand";
	import { page } from "$app/state";
	import LanguageLeaderboard from "$lib/chat/components/leaderboard/LanguageLeaderboard.svelte";
	import { LAUNCH_LANGUAGES } from "$lib/chat/languageData";

	let { data } = $props();
	const title = $derived(`How Alpha’s models read your language – ${brandOf(page.data).product}`);
	const description = `Belebele reading-test scores for each model in Alpha, in ${LAUNCH_LANGUAGES.length} languages, with the evidence behind every score.`;
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={data.canonicalUrl} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={data.canonicalUrl} />
</svelte:head>

<LanguageLeaderboard openingLanguage={data.openingLanguage} />
