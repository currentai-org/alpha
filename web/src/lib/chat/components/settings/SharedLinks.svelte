<script lang="ts">
	// Settings → Data & privacy → Shared links: every read-only link this account has made,
	// with a way to stop each one. Revoking deletes the link's snapshot; the chat itself stays.
	import { base } from '$lib/chat/paths';
	import { page } from '$app/state';
	import { Button, Surface } from '@aipotluck/alpha-ds';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';

	type Share = { id: string; conversationId: string; title: string; createdAt: string };

	let shares = $state<Share[] | null>(null);
	let errorText = $state('');
	let revoking = $state<string | null>(null);

	$effect(() => {
		fetch(`${base}/api/v2/shares`)
			.then(async (r) => {
				if (!r.ok) throw new Error();
				shares = ((await r.json()) as { shares: Share[] }).shares;
			})
			.catch(() => (errorText = "Couldn't load your shared links. Reload to try again."));
	});

	async function revoke(id: string) {
		revoking = id;
		errorText = '';
		try {
			const r = await fetch(`${base}/api/v2/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
			// A 404 means the link is already gone, which is what the person asked for.
			if (!r.ok && r.status !== 404) throw new Error();
			shares = (shares ?? []).filter((s) => s.id !== id);
		} catch {
			errorText = "Couldn't stop sharing that link. Please try again.";
		} finally {
			revoking = null;
		}
	}

	function sharedOn(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime())
			? ''
			: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}
</script>

<section class="flex flex-col gap-3" aria-labelledby="shared-links-heading" data-testid="shared-links">
	<h2 id="shared-links-heading" class="type-label text-fg-1">Shared links</h2>
	<p class="type-caption text-fg-3">
		Anyone with one of these links can read that chat as it stood when you shared it. Stop sharing
		and the link stops working; the chat stays in your history.
	</p>
	{#if errorText}
		<p class="type-caption text-fg-1" role="alert">{errorText}</p>
	{/if}
	{#if shares === null && !errorText}
		<p class="type-caption text-fg-3">Loading…</p>
	{:else if shares && shares.length === 0}
		<p class="type-body text-fg-2">You haven't shared any chats.</p>
	{:else if shares}
		<Surface level="2" border="auto">
			<ul class="flex flex-col divide-y divide-line-surface">
				{#each shares as share (share.id)}
					<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
						<div class="flex min-w-0 flex-col gap-0.5">
							<a
								href="{base}/conversation/{share.conversationId}"
								class="truncate type-body text-fg-1 hover:underline">{share.title}</a
							>
							<span class="type-caption text-fg-3">Shared {sharedOn(share.createdAt)}</span>
						</div>
						<div class="flex items-center gap-2">
							<a
								href="{page.url.origin}{base}/r/{share.id}"
								target="_blank"
								rel="noopener"
								class="inline-flex items-center gap-1 type-caption text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
							>
								<RiArrowRightUpLine aria-hidden="true" class="size-3.5" /> Open link
							</a>
							<Button
								variant="destructive"
								size="sm"
								onclick={() => revoke(share.id)}
								disabled={revoking === share.id}
								aria-label="Stop sharing {share.title}"
							>
								{revoking === share.id ? 'Stopping…' : 'Stop sharing'}
							</Button>
						</div>
					</li>
				{/each}
			</ul>
		</Surface>
	{/if}
</section>
