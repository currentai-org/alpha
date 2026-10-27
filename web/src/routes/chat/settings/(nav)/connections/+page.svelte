<script lang="ts">
	import { m } from "$lib/paraglide/messages.js";
	import { enhance } from "$app/forms";
	import { getLocale } from "$lib/paraglide/runtime.js";
	import { Button } from "@aipotluck/alpha-ds";
	import RiLinkUnlink from "~icons/ri/link-unlink";
	import type { ActionData, PageData } from "./$types";

	// Settings → Connections (CUR-4312): each app allowed to read and write this account's
	// conversations, with Disconnect. Reached from Account's "Keep Thunderbolt in sync" row.
	let { data, form }: { data: PageData; form: ActionData } = $props();

	const when = (iso: string) =>
		new Date(iso).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
</script>

<div class="flex flex-col gap-4" data-testid="sync-connections">
	<p class="type-body text-fg-2">{m.connections_intro()}</p>
	{#if form?.disconnected}
		<p class="type-caption text-fg-2" role="status" data-testid="sync-disconnected">
			{m.connections_disconnected({ app: form.label })}
		</p>
	{/if}
	{#if data.connections.length === 0}
		<p class="type-body text-fg-3" data-testid="sync-connections-empty">{m.connections_empty()}</p>
	{:else}
		<ul class="flex flex-col gap-3" aria-label={m.product_connections()}>
			{#each data.connections as c (c.clientId)}
				<li
					class="flex items-center justify-between gap-3 border border-line-2 p-3 rounded-card"
					data-sync-connection={c.clientId}
				>
					<div class="min-w-0">
						<div class="truncate type-body text-fg-1">{c.label}</div>
						<div class="type-caption text-fg-3">{c.host} · {m.connections_since({ date: when(c.since) })}</div>
					</div>
					<form method="POST" action="?/disconnect" use:enhance>
						<input type="hidden" name="clientId" value={c.clientId} />
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							casing="sentence"
							aria-label={m.connections_disconnectAria({ app: c.label })}
						>
							<RiLinkUnlink aria-hidden="true" />
							<span>{m.connections_disconnect()}</span>
						</Button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>
