<script lang="ts">
	import { onMount } from 'svelte';
	import { Banner } from '$lib/components/ui/banner';
	import { base } from '$lib/chat/paths';
	import { m } from '$lib/paraglide/messages.js';
	import RiArrowUpRight from '~icons/ri/arrow-right-up-line';

	// While the installation's status page reports a problem, say so above the chat and link there, so a
	// visitor whose answers are failing learns it is us and not them. Silent when the status page reads
	// operational or cannot be read. Dismissing hides it for this page view only, like MaintenanceBanner.
	// The page comes from the server: STATUS_PAGE_URL, or none on a self-host without it.
	let pageState = $state<string | null>(null);
	let pageUrl = $state<string | null>(null);
	let dismissed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(`${base}/api/status`);
			if (res.ok) {
				const body = (await res.json()) as { state: string | null; url?: string | null };
				pageState = body.state;
				pageUrl = body.url ?? null;
			}
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

{#if message && pageUrl && !dismissed}
	<Banner dismissible ondismiss={() => (dismissed = true)} data-status-banner={pageState}>
		{message}<a
			href={pageUrl}
			target="_blank"
			rel="noreferrer"
			class="ml-3 inline-flex items-center gap-0.5 underline underline-offset-2"
			><RiArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" />{m.message_statusPage()}</a
		>
	</Banner>
{/if}
