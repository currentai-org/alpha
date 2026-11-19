<!--
  @component
  The unlock prompt in a browser with no device key for an account that has a history key (
  stage 2). Opens with the recovery key or a passkey, then wraps the key again with this
  browser's new device key added, so the next visit opens without asking. Until stage 3 seals anything,
  chats stay readable whether or not it is answered, so "Not now" closes it until the next page load.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Dialog, Field, Inline, Stack } from '@aipotluck/alpha-ds';
	import RiFingerprintLine from '~icons/ri/fingerprint-line';
	import {
		passkeyPrfOffered,
		unlockAndAddThisBrowser,
		type HistoryKeyApi,
		type HistoryKeyState,
		type StoredHistoryKey
	} from '$lib/chat/crypto/historyKeyClient';
	import type { Unlocker } from '$lib/chat/crypto/historyIdentity';

	let {
		api,
		owner,
		stored,
		deviceLabel,
		ondone,
		ondismiss
	}: {
		api: HistoryKeyApi;
		owner: string;
		stored: StoredHistoryKey;
		deviceLabel: string;
		ondone: (state: Extract<HistoryKeyState, { kind: 'unlocked' }>) => void;
		ondismiss: () => void;
	} = $props();

	let open = $state(true);
	let recoveryKey = $state('');
	let busy = $state<'' | 'recovery' | 'passkey'>('');
	let error = $state('');
	let passkeyAvailable = $state(false);

	onMount(() => {
		void passkeyPrfOffered().then((ok) => (passkeyAvailable = ok));
	});

	async function unlock(unlocker: Exclude<Unlocker, { kind: 'device' }>) {
		busy = unlocker.kind;
		error = '';
		try {
			ondone(await unlockAndAddThisBrowser(api, owner, stored, unlocker, deviceLabel));
			open = false;
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (code === 'not_for_this_unlocker') {
				error =
					unlocker.kind === 'recovery'
						? "That recovery key doesn't open this account's history. Check it and try again."
						: "That passkey doesn't open this account's history.";
			} else if (unlocker.kind === 'passkey' && !code) {
				console.warn('[history-key] passkey unlock did not finish', e);
				error = 'The passkey was cancelled or could not be used.';
			} else {
				// Never the error itself for a recovery key: its message can carry the typed key.
				if (unlocker.kind === 'recovery') console.error('[history-key] unlock failed', { code: code ?? 'unknown' });
				else console.error('[history-key] unlock failed', e);
				error = "Your history couldn't be unlocked. Check your connection and try again.";
			}
		} finally {
			busy = '';
		}
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (recoveryKey.trim()) void unlock({ kind: 'recovery', recoveryKey: recoveryKey.trim() });
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) ondismiss();
	}}
>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="history-key-unlock-prompt">
			<form class="contents" onsubmit={submit}>
				<Stack gap="4">
					<Dialog.Title>Unlock your chat history in this browser</Dialog.Title>
					<Dialog.Description>
						This browser doesn't hold your history key yet. Use the recovery key you saved, or a
						passkey you added, to let this browser open it from now on.
					</Dialog.Description>
					<Field.Root invalid={!!error && busy === ''}>
						<Field.Label>Recovery key</Field.Label>
						<Field.Control
							bind:value={recoveryKey}
							autocomplete="off"
							spellcheck="false"
							oninput={() => (error = '')}
						/>
					</Field.Root>
					{#if error}
						<p class="type-caption text-fg-1" role="alert">{error}</p>
					{/if}
					<Inline justify="end" gap="2">
						{#if passkeyAvailable}
							<Button
								casing="sentence"
								disabled={!!busy}
								onclick={() => unlock({ kind: 'passkey' })}
							>
								<RiFingerprintLine aria-hidden="true" />
								<span>{busy === 'passkey' ? 'Waiting for your device…' : 'Use a passkey'}</span>
							</Button>
						{/if}
						<Dialog.Close disabled={!!busy}>Not now</Dialog.Close>
						<Button type="submit" variant="primary" casing="sentence" disabled={!!busy || !recoveryKey.trim()}>
							{busy === 'recovery' ? 'Unlocking…' : 'Unlock'}
						</Button>
					</Inline>
				</Stack>
			</form>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
