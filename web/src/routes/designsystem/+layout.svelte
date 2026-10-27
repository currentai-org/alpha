<script lang="ts">
	import Seo from '$lib/components/seo/seo.svelte';
	import { resolvePageTitle } from '$lib/constants/site';
	import DocsShell from '@aipotluck/alpha-ds/catalog/ui/DocsShell.svelte';

	let { data, children } = $props();
</script>

<Seo
	title={resolvePageTitle({ title: 'Alpha design system' })}
	description="Tokens, Base UI–shaped components, primitives and patterns for Alpha."
	canonicalPath="/designsystem"
/>

<DocsShell version={data.dsVersion}>{@render children()}</DocsShell>
