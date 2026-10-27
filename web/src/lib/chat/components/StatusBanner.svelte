<script lang="ts">
	import { onMount } from 'svelte';
	import { Banner } from '$lib/components/ui/banner';
	import { base } from '$lib/chat/paths';
	import { m } from '$lib/paraglide/messages.js';
	import RiArrowUpRight from '~icons/ri/arrow-right-up-line';

	// While status.aipotluck.org reports a problem, say so above the chat and link there, so a
	// visitor whose answers are failing learns it is us and not them. Silent when the status page reads
	// operational or cannot be read. Dismissing hides it for this page view only, like MaintenanceBanner. (CUR-4062)
	let pageState = $state<string | null>(null);
	let dismissed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(`${base}/api/status`);
			if (res.ok) pageState = ((await res.json()) as { state: string | null }).state;
		} catch {
			// No banner is the right answer when we cannot tell.
		}
	});

	const message = $derived(
		pageState === 'degraded' || pageState === 'downtime'
			? m.chat_statusBannerIncident()
			: pageState === 'maintenance'
				? m.chat_statusBannerMaintenance()
				: null
	);
</script>

{#if message && !dismissed}
	<Banner dismissible ondismiss={() => (dismissed = true)} data-status-banner={pageState}>
		{message}<a
			href="https://status.aipotluck.org"
			target="_blank"
			rel="noreferrer"
			class="ml-3 inline-flex items-center gap-0.5 underline underline-offset-2"
			><RiArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" />{m.message_statusPage()}</a
		>
	</Banner>
{/if}
