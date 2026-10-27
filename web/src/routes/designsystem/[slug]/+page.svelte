<script lang="ts">
	import { FOUNDATION_PAGES } from '@aipotluck/alpha-ds/catalog/foundations';
	import { getItem } from '@aipotluck/alpha-ds/catalog/registry';
	import ItemPage from '@aipotluck/alpha-ds/catalog/ui/ItemPage.svelte';

	let { data } = $props();
	const Foundation = $derived(data.kind === 'foundation' ? FOUNDATION_PAGES[data.slug] : undefined);
	const item = $derived(data.kind === 'item' ? getItem(data.slug) : undefined);
</script>

<svelte:head>
	<title>{item?.name ?? data.slug} · Alpha design system</title>
</svelte:head>

{#key data.slug}
	{#if data.kind === 'foundation' && Foundation}
		<Foundation snippets={data.snippets} changelog={data.changelog} />
	{:else if data.kind === 'item' && item}
		<ItemPage {item} examples={data.examples} anatomyHtml={data.anatomyHtml} />
	{/if}
{/key}
