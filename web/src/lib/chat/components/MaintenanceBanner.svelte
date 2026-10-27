<script lang="ts">
	import { Banner } from '$lib/components/ui/banner';

	// `banner` comes from the Payload `maintenance-banner` global (loadChatShellData), fetched
	// per-request (subject to the Payload SWR cache) rather than bundled at build time.
	let { banner }: { banner: { enabled: boolean; message: string } } = $props();

	// Dismiss is deliberately NOT persisted: the × hides it for the current view only, and it
	// comes back on the next page load. In-memory state resets on every refresh/navigation.
	let dismissed = $state(false);

	let show = $derived(banner.enabled && !dismissed);
</script>

{#if show}
	<Banner dismissible ondismiss={() => (dismissed = true)}>{banner.message}</Banner>
{/if}
