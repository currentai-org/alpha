<script lang="ts">
	import { page } from '$app/state';
	import ChatShell from '$lib/chat/components/ChatShell.svelte';

	let { data = $bindable(), children } = $props();

	// The landing page (+page.server.ts) hands its head tags to a Payload page when one exists at
	// slug `chat`; ChatShell's own tags stand down only on that page and only then.
	const hasPageSeo = $derived(Boolean(page.data.landingSeoPage));
</script>

<ChatShell bind:data {hasPageSeo}>
	{@render children?.()}
</ChatShell>
