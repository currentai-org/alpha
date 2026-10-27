<script lang="ts">
	import { PageSeo } from '$lib/websiteSeo';
	import ChatLanding from '$lib/chat/components/ChatLanding.svelte';
	import { chatHome } from '$lib/chat/paths';

	let { data } = $props();
</script>

{#if PageSeo && data.landingSeoPage}
	<PageSeo page={data.landingSeoPage} canonicalPath={chatHome} />
{/if}

<ChatLanding models={data.models} />
