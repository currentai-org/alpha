<script lang="ts">
	// Share a read-only link to one chat, from the side rail's Conversation actions. Ported
	// in spirit from upstream chat-ui's ShareConversationModal (Apache-2.0), rebuilt on the Alpha DS,
	// with what upstream lacks: a link that can be refreshed and revoked.
	//
	// The link shows the chat as it stands when it is created or refreshed. Messages sent afterwards
	// stay private until the person refreshes the link.
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';
	import { Button, Dialog, Field, Inline } from '@aipotluck/alpha-ds';
	import RiLinkM from '~icons/ri/link-m';

	interface Props {
		open?: boolean;
		conversationId: string;
		title: string;
	}

	let { open = $bindable(false), conversationId, title }: Props = $props();

	type Share = { id: string; createdAt: string; updatedAt: string };

	let share = $state<Share | null>(null);
	let loading = $state(false);
	let busy = $state<'create' | 'refresh' | 'revoke' | null>(null);
	let errorText = $state('');
	let copied = $state(false);
	// A sealed chat's words open only with the person's history key. Sharing one is a release: this
	// browser opens it and sends a readable copy for the link, after the disclosure below says so.
	// The chat itself stays sealed.
	let sealed = $state(false);

	const endpoint = $derived(`${base}/api/v2/conversations/${conversationId}/share`);
	const shareUrl = $derived(share ? `${page.url.origin}${base}/r/${share.id}` : '');

	$effect(() => {
		if (!open) return;
		errorText = '';
		copied = false;
		loading = true;
		sealed = false;
		// Imported here: a static import of the API client breaks the browser component tests.
		const sealedCheck = import('$lib/chat/utils/sealedRequest')
			.then(({ conversationIsSealed }) => conversationIsSealed(conversationId))
			.then((s) => (sealed = s));
		Promise.all([
			fetch(endpoint).then(async (r) => {
				if (!r.ok) throw new Error(await failure(r));
				share = ((await r.json()) as { share: Share | null }).share;
			}),
			sealedCheck
		])
			.catch((e: Error) => (errorText = e.message))
			.finally(() => (loading = false));
	});

	async function failure(r: Response): Promise<string> {
		const body = (await r.json().catch(() => null)) as { message?: string } | null;
		return body?.message ?? "Couldn't reach the share link. Please try again.";
	}

	// The branch this tab is reading (the conversation page keeps it per tab), so the link
	// shows what the person sees. Absent, the server takes the newest message.
	function currentLeaf(): string | undefined {
		try {
			return sessionStorage.getItem(`leafId:${conversationId}`) ?? undefined;
		} catch {
			return undefined;
		}
	}

	async function createOrRefresh(kind: 'create' | 'refresh') {
		busy = kind;
		errorText = '';
		try {
			const { sealedReleaseForShare, SealedReleaseError } = await import('$lib/chat/utils/sealedRequest');
			// Empty for a chat with nothing sealed; refuses a locked browser rather than sharing it empty.
			const release = await sealedReleaseForShare(conversationId, historyKeyring.identity).catch((e) => {
				if (e instanceof SealedReleaseError && e.reason === 'locked') historyKeyring.askToUnlock();
				throw e;
			});
			const r = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ leafId: currentLeaf(), ...release })
			});
			if (!r.ok) throw new Error(await failure(r));
			share = ((await r.json()) as { share: Share }).share;
			copied = false;
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			busy = null;
		}
	}

	async function revoke() {
		busy = 'revoke';
		errorText = '';
		try {
			const r = await fetch(endpoint, { method: 'DELETE' });
			if (!r.ok) throw new Error(await failure(r));
			share = null;
		} catch (e) {
			errorText = (e as Error).message;
		} finally {
			busy = null;
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
		} catch {
			errorText = 'Copying was blocked. Select the link and copy it yourself.';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="share-conversation-dialog">
			<Dialog.Title>Share chat</Dialog.Title>
			<Dialog.Description>
				{#if share}
					Anyone with this link can read “{title}” as it stood when the link was made or last
					updated. Messages sent since stay private unless you update the link.
				{:else}
					Create a link anyone can use to read “{title}” as it is now, without signing in. Messages
					you send after sharing stay private. Files and images are not shared.
				{/if}
			</Dialog.Description>
			<div class="flex flex-col gap-4">
				{#if sealed}
					<p class="type-caption text-fg-2" data-testid="share-sealed-disclosure">
						This chat is sealed with your key. {share ? 'Updating' : 'Creating'} the link sends a readable copy of it
						to our server for the link to show; the chat itself stays sealed.
					</p>
				{/if}
				{#if share}
					<Field.Root>
						<Field.Label>Link</Field.Label>
						<Field.Control value={shareUrl} readonly data-testid="share-link-url" />
					</Field.Root>
				{/if}
				{#if errorText}
					<p class="type-caption text-fg-1" role="alert">{errorText}</p>
				{/if}
				<Inline justify="end" gap="2">
					{#if share}
						<Button variant="destructive" onclick={revoke} disabled={!!busy}>
							{busy === 'revoke' ? 'Stopping…' : 'Stop sharing'}
						</Button>
						<Button onclick={() => createOrRefresh('refresh')} disabled={!!busy}>
							{busy === 'refresh' ? 'Updating…' : 'Update link'}
						</Button>
						<Button variant="primary" onclick={copy} disabled={!!busy}>
							{copied ? 'Copied' : 'Copy link'}
						</Button>
					{:else}
						<Dialog.Close>Cancel</Dialog.Close>
						<Button
							variant="primary"
							onclick={() => createOrRefresh('create')}
							disabled={loading || !!busy}
						>
							<RiLinkM aria-hidden="true" />
							{busy === 'create' ? 'Creating…' : 'Create link'}
						</Button>
					{/if}
				</Inline>
			</div>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
