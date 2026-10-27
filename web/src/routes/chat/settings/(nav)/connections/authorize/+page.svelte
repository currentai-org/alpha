<script lang="ts">
	import { m } from "$lib/paraglide/messages.js";
	import { AUTH_BASE_PATH } from "$lib/chat/paths";
	import { Button } from "@aipotluck/alpha-ds";
	import RiCheckLine from "~icons/ri/check-line";
	import RiCloseLine from "~icons/ri/close-line";
	import type { PageData } from "./$types";

	// Allow or Deny for a sync client. The answer goes to the oauth-provider plugin's consent
	// endpoint with the signed query this page was opened with, and the browser follows the URL it
	// returns: the client's redirect_uri with a code, or with error=access_denied. A full-page
	// navigation, because the client opened this page as one (it sends COOP same-origin, so no popup). (CUR-4312)
	let { data }: { data: PageData } = $props();
	let busy = $state(false);
	let failed = $state(false);

	async function answer(accept: boolean) {
		busy = true;
		failed = false;
		try {
			const res = await fetch(`${AUTH_BASE_PATH}/oauth2/consent`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accept, oauth_query: window.location.search.replace(/^\?/, "") }),
			});
			const body = (await res.json().catch(() => null)) as { url?: string; uri?: string } | null;
			const next = body?.url ?? body?.uri;
			if (!res.ok || !next) throw new Error(`consent ${res.status}`);
			window.location.href = next;
		} catch {
			failed = true;
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-4" data-testid="sync-authorize">
	{#if data.client}
		<h2 class="type-label text-fg-1">{m.authorize_title({ app: data.client.label })}</h2>
		<p class="type-body text-fg-1" data-testid="sync-authorize-ask">
			{m.authorize_ask({ app: data.client.label, host: data.client.host })}
		</p>
		<p class="type-body text-fg-2">{m.authorize_detail({ app: data.client.label })}</p>
		{#if failed}
			<p class="type-caption text-fg-2" role="alert">{m.authorize_failed({ app: data.client.label })}</p>
		{/if}
		<div class="flex gap-2">
			<Button variant="primary" casing="sentence" disabled={busy} onclick={() => answer(true)} data-testid="sync-allow">
				<RiCheckLine aria-hidden="true" />
				<span>{m.authorize_allow()}</span>
			</Button>
			<Button variant="secondary" casing="sentence" disabled={busy} onclick={() => answer(false)} data-testid="sync-deny">
				<RiCloseLine aria-hidden="true" />
				<span>{m.authorize_deny()}</span>
			</Button>
		</div>
	{:else}
		<p class="type-body text-fg-2" data-testid="sync-authorize-unknown">{m.authorize_unknown()}</p>
	{/if}
</div>
