<script lang="ts">
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { localeAlternates, localizedHref } from '$lib/i18n/routing';
	import { resolveCanonicalUrl } from '$lib/constants/site';

	let {
		title,
		description,
		ogImage,
		ogType = 'website',
		canonicalPath,
		jsonLd
	}: {
		title: string;
		description?: string | null;
		ogImage?: string | null;
		ogType?: string;
		canonicalPath: string;
		jsonLd?: object | object[];
	} = $props();

	const canonicalUrl = $derived(resolveCanonicalUrl(localizedHref(canonicalPath, getLocale())));
	// Split so the literal substring can't be mistaken for a real tag by tooling that scans raw
	// source text for it (the svelte/eslint parsers both do, even inside a JS string).
	const LD_JSON_OPEN = '<' + 'script type="application/ld+json">';
	const LD_JSON_CLOSE = '<' + '/script>';
	// A literal closing script tag inside JSON-LD string content would otherwise end the
	// script element that renders it early.
	const jsonLdMarkup = $derived(jsonLd ? JSON.stringify(jsonLd).replace(/</g, '\\u003c') : null);
</script>

<svelte:head>
	<title>{title}</title>
	<link rel="canonical" href={canonicalUrl} />
	{#each localeAlternates(canonicalPath) as alternate (alternate.locale)}
		<link rel="alternate" hreflang={alternate.locale} href={resolveCanonicalUrl(alternate.href)} />
	{/each}
	{#if localeAlternates(canonicalPath).length}
		<link
			rel="alternate"
			hreflang="x-default"
			href={resolveCanonicalUrl(localizedHref(canonicalPath, 'en'))}
		/>
	{/if}
	{#if description}
		<meta name="description" content={description} />
		<meta property="og:description" content={description} />
		<meta name="twitter:description" content={description} />
	{/if}
	<meta property="og:title" content={title} />
	<meta property="og:type" content={ogType} />
	<meta property="og:url" content={canonicalUrl} />
	{#if ogImage}
		<meta property="og:image" content={ogImage} />
		<meta name="twitter:image" content={ogImage} />
	{/if}
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	{#if jsonLdMarkup}
		<!-- jsonLdMarkup is JSON.stringify output with `<` escaped, not user input; @html is
		     needed here to emit a real script element. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html `${LD_JSON_OPEN}${jsonLdMarkup}${LD_JSON_CLOSE}`}
	{/if}
</svelte:head>
