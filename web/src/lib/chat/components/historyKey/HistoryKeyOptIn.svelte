<!--
  @component
  "Encrypt my chat history", opened from Settings → Account → Your key.
  Encryption is a choice the person makes here, never a step forced at sign-in, on the model of Apple
  Advanced Data Protection and Signal secure backups: it cannot turn on until a
  recovery method exists, either a recovery key typed back or a passkey that can hold the key (PRF), and
  one plain sentence says that losing every way in loses the history. There is no device-only choice.

  Turning it on makes the key, wraps it to this browser and the recovery method, and stores it; the
  server then seals the account's existing chats to it. Nothing is deleted.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Dialog, Inline, Stack } from '@aipotluck/alpha-ds';
	import RiKey2Line from '~icons/ri/key-2-line';
	import RiFingerprintLine from '~icons/ri/fingerprint-line';
	import RiCheckLine from '~icons/ri/check-line';
	import { createPasskeyCredential } from '$lib/chat/crypto/historyIdentity';
	import {
		enrollOrJoinHistoryKey,
		passkeyPrfOffered,
		type EnrollChoice,
		type HistoryKeyApi,
		type HistoryKeyState
	} from '$lib/chat/crypto/historyKeyClient';
	import RecoveryKeyMaker from './RecoveryKeyMaker.svelte';
	import { newPasskeyLabel, newRecoveryKeyLabel, thisDeviceLabel } from './historyKeyLabels';

	type RecoveryMethod = Exclude<EnrollChoice, { kind: 'device-only' }>;

	let {
		api,
		owner,
		onclose,
		ondone,
		onconflict
	}: {
		api: HistoryKeyApi;
		owner: string;
		onclose: () => void;
		ondone: (state: Extract<HistoryKeyState, { kind: 'unlocked' }>) => void;
		/** Another browser turned encryption on first and this one can't open its key: unlock instead. */
		onconflict: () => void;
	} = $props();

	let step = $state<'intro' | 'recovery'>('intro');
	let method = $state<RecoveryMethod | null>(null);
	let busy = $state<'' | 'passkey' | 'enroll'>('');
	let error = $state('');
	let passkeyAvailable = $state(false);
	let notKept = $state(false);

	onMount(() => {
		void passkeyPrfOffered().then((ok) => (passkeyAvailable = ok));
	});

	async function addPasskey() {
		busy = 'passkey';
		error = '';
		try {
			const label = newPasskeyLabel();
			method = { kind: 'passkey', credential: await createPasskeyCredential(label), label };
		} catch (e) {
			console.warn('[history-key] passkey not made', e);
			error =
				"That passkey can't hold your key, or it was cancelled. Save a recovery key instead, or try another passkey.";
		} finally {
			busy = '';
		}
	}

	async function turnOn() {
		if (!method) return;
		busy = 'enroll';
		error = '';
		try {
			ondone(await enrollOrJoinHistoryKey(api, owner, method, thisDeviceLabel()));
		} catch (e) {
			if ((e as { code?: string }).code === 'not_kept') {
				notKept = true;
				return;
			}
			console.error('[history-key] enrollment failed', e);
			error = "Encryption couldn't be turned on. Check your connection and try again.";
		} finally {
			busy = '';
		}
	}
</script>

<Dialog.Root
	open={true}
	onOpenChange={(next) => {
		if (!next && busy !== 'enroll') onclose();
	}}
>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="history-key-opt-in">
			<Stack gap="4">
				<Dialog.Title>Encrypt my chat history</Dialog.Title>
				{#if notKept}
					<Dialog.Description data-testid="history-key-not-kept">
						Encryption was turned on in another browser while this was open, so what you just set up
						wasn't kept. Unlock with a way in you added there.
					</Dialog.Description>
					<Inline justify="end">
						<Button variant="primary" casing="sentence" onclick={onconflict}>Unlock my history</Button>
					</Inline>
				{:else if step === 'recovery'}
					<RecoveryKeyMaker
						cancelLabel="Back"
						oncancel={() => (step = 'intro')}
						onconfirmed={(made) => {
							method = { kind: 'recovery', recipient: made.recipient, label: newRecoveryKeyLabel() };
							step = 'intro';
						}}
					/>
				{:else}
					<Dialog.Description>
						Your chats get a key that only you hold, kept in this browser. AI Potluck stores them but
						can't read them. The chats you already have are then sealed to the same key, and none are
						deleted. Your own key does not cover attachments or uploaded files: those stay on the
						server-held key for now.
					</Dialog.Description>
					<p class="type-body text-fg-1" data-testid="history-key-loss-warning">
						If you lose every way in, your chat history is lost for good. AI Potluck can't recover it.
					</p>
					{#if method}
						<p class="flex items-center gap-2 type-body text-fg-1" data-testid="history-key-method-ready">
							<RiCheckLine class="size-4 flex-none" aria-hidden="true" />
							<span>{method.kind === 'recovery' ? 'Recovery key saved' : 'Passkey added'}</span>
						</p>
					{:else}
						<Stack gap="2">
							<p class="type-caption text-fg-2">
								First, set up a way back in for when this browser's copy is gone.
							</p>
							<Button casing="sentence" block disabled={!!busy} onclick={() => (step = 'recovery')}>
								<RiKey2Line aria-hidden="true" />
								<span>Save a recovery key</span>
							</Button>
							{#if passkeyAvailable}
								<Button casing="sentence" block disabled={!!busy} onclick={addPasskey}>
									<RiFingerprintLine aria-hidden="true" />
									<span>{busy === 'passkey' ? 'Waiting for your device…' : 'Add a passkey'}</span>
								</Button>
							{/if}
						</Stack>
					{/if}
					<Inline justify="end" gap="2">
						<Button casing="sentence" disabled={busy === 'enroll'} onclick={onclose}>Cancel</Button>
						<Button variant="primary" casing="sentence" disabled={!method || !!busy} onclick={turnOn}>
							{busy === 'enroll' ? 'Turning on…' : 'Turn on encryption'}
						</Button>
					</Inline>
				{/if}
				{#if error}
					<p class="type-caption text-fg-1" role="alert">{error}</p>
				{/if}
			</Stack>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
