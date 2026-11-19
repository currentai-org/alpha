<script lang="ts">
	import LanguageLeaderboard from "$lib/chat/components/leaderboard/LanguageLeaderboard.svelte";
	import { LAUNCH_LANGUAGES } from "$lib/chat/languageData";

	let { data } = $props();
	const title = "How Alpha’s models read your language – AI Potluck";
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
