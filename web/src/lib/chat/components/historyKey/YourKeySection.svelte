<!--
  @component
  Settings → Account → Your key (stage 2). Where an account with no history key
  turns encryption on, by choice (HistoryKeyOptIn). Once it is on, lists the ways into the
  person's history key by the labels kept inside it, adds a recovery key or a passkey, removes one
  (never the last), and forgets this browser's device key. Every change is a rewrap from this browser,
  so the section needs the key unlocked here first; a locked browser is offered the unlock prompt.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Dialog, Stack, Surface } from '@aipotluck/alpha-ds';
	import RiKey2Line from '~icons/ri/key-2-line';
	import RiFingerprintLine from '~icons/ri/fingerprint-line';
	import RiComputerLine from '~icons/ri/computer-line';
	import RiAddLine from '~icons/ri/add-line';
	import RiLockLine from '~icons/ri/lock-line';
	import RiDeleteBinLine from '~icons/ri/delete-bin-line';
	import { createPasskeyCredential, type WrapRecipient } from '$lib/chat/crypto/historyIdentity';
	import {
		addWayIn,
		forgetThisBrowser,
		historyKeyApi,
		historyKeyOwner,
		isThisBrowser,
		passkeyPrfOffered,
		readHistoryKeyState,
		removeWayIn,
		type ExistingChats,
		type HistoryKeyState
	} from '$lib/chat/crypto/historyKeyClient';
	import RecoveryKeyMaker from './RecoveryKeyMaker.svelte';
	import HistoryKeyUnlockPrompt from './HistoryKeyUnlockPrompt.svelte';
	import HistoryKeyOptIn from './HistoryKeyOptIn.svelte';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';
	import { newPasskeyLabel, newRecoveryKeyLabel, thisDeviceLabel } from './historyKeyLabels';

	let { userId }: { userId: string } = $props();

	const api = historyKeyApi();
	const owner = $derived(historyKeyOwner(userId));

	let keyState = $state<HistoryKeyState | null>(null);
	let loadError = $state('');
	let actionError = $state('');
	let busy = $state('');
	let passkeyAvailable = $state(false);
	let addingRecovery = $state(false);
	let unlocking = $state(false);
	let optingIn = $state(false);
	/** Set once encryption was turned on here: what the server said became of the chats already there. */
	let justTurnedOn = $state<{ existingChats?: ExistingChats } | null>(null);

	async function load() {
		loadError = '';
		try {
			keyState = await readHistoryKeyState(api, owner);
		} catch (e) {
			console.error('[history-key] could not read the history key', e);
			loadError = "Your key couldn't be read. Reload the page to try again.";
		}
	}

	onMount(() => {
		void load();
		void passkeyPrfOffered().then((ok) => (passkeyAvailable = ok));
	});

	const unlocked = $derived(keyState?.kind === 'unlocked' ? keyState : null);
	const ways = $derived(unlocked?.unlocked.recipients ?? []);

	function kindLabel(r: WrapRecipient): string {
		if (r.kind === 'recovery') return 'Recovery key';
		if (r.kind === 'passkey') return 'Passkey';
		return unlocked && isThisBrowser(r, unlocked.deviceRecipient) ? 'This browser' : 'Browser';
	}

	function wayId(r: WrapRecipient): string {
		return r.kind === 'passkey' ? r.credential : r.recipient;
	}

	async function run(key: string, change: () => Promise<void>) {
		busy = key;
		actionError = '';
		try {
			await change();
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (code === 'last_recipient') {
				actionError = 'This is the only way into your history, so it stays. Add another way in first.';
			} else {
				console.error('[history-key] change failed', e);
				actionError = "That change couldn't be saved. Check your connection and try again.";
			}
			await load();
		} finally {
			busy = '';
		}
	}

	function remove(r: WrapRecipient) {
		if (!unlocked) return;
		if (ways.length <= 1) {
			actionError = 'This is the only way into your history, so it stays. Add another way in first.';
			return;
		}
		const state = unlocked;
		void run(`remove:${wayId(r)}`, async () => {
			keyState = await removeWayIn(api, owner, state, r);
		});
	}

	function forget() {
		if (!unlocked) return;
		if (ways.length <= 1) {
			actionError =
				"This browser is the only way into your history. Add a recovery key or a passkey before forgetting it.";
			return;
		}
		const state = unlocked;
		void run('forget', async () => {
			await forgetThisBrowser(api, owner, state);
			await load();
		});
	}

	function addPasskey() {
		if (!unlocked) return;
		const state = unlocked;
		void run('add-passkey', async () => {
			const label = newPasskeyLabel();
			const credential = await createPasskeyCredential(label);
			keyState = await addWayIn(api, owner, state, { kind: 'passkey', credential, label });
		});
	}

	function addRecovery(made: { recipient: string }) {
		if (!unlocked) return;
		const state = unlocked;
		void run('add-recovery', async () => {
			keyState = await addWayIn(api, owner, state, {
				kind: 'recovery',
				recipient: made.recipient,
				label: newRecoveryKeyLabel()
			});
			addingRecovery = false;
		});
	}
</script>

<section class="flex flex-col gap-2" data-testid="history-key-section">
	<h3 class="type-caption text-fg-2 uppercase">Your key</h3>
	<Surface level="2" border="auto">
		{#if loadError}
			<p class="px-3 py-3 type-caption text-fg-1">{loadError}</p>
		{:else if !keyState}
			<p class="px-3 py-3 type-caption text-fg-3">Loading…</p>
		{:else if keyState.kind === 'none'}
			<div class="flex flex-col gap-3 px-3 py-3" data-testid="history-key-off">
				<p class="type-caption text-fg-2">
					Your chat history isn't encrypted. Turn it on and your chats are sealed to a key only you
					hold, so AI Potluck can't read them. You'll set up a recovery key or a passkey first.
					Attachments and uploaded files are not covered by your own key.
				</p>
				<div>
					<Button size="sm" casing="sentence" onclick={() => (optingIn = true)}>
						<RiLockLine aria-hidden="true" />
						<span>Encrypt my chat history</span>
					</Button>
				</div>
			</div>
		{:else if keyState.kind === 'locked'}
			<div class="flex items-center justify-between gap-3 px-3 py-3">
				<p class="type-caption text-fg-2">
					This browser can't open your history key yet, so the ways in aren't shown here.
				</p>
				<Button size="sm" casing="sentence" onclick={() => (unlocking = true)}>Unlock</Button>
			</div>
		{:else}
			{#if justTurnedOn}
				<p
					class="border-b border-line-surface px-3 py-3 type-caption text-fg-1"
					data-testid="history-key-turned-on"
					data-existing-chats={justTurnedOn.existingChats ?? 'unknown'}
				>
					{#if justTurnedOn.existingChats === 'sealed'}
						Encryption is on. Your existing chats are sealed to your key.
					{:else if justTurnedOn.existingChats === 'not_sealed'}
						Encryption is on for new chats. Your existing chats couldn't be sealed yet, so they are
						stored as they were.
					{:else}
						Encryption is on.
					{/if}
				</p>
			{/if}
			<p class="border-b border-line-surface px-3 py-3 type-caption text-fg-3">
				These open your chat history. AI Potluck can't open it without one of them. If you lose all of
				them, your history is lost.
			</p>
			{#each ways as r (wayId(r))}
				{@const mine = unlocked !== null && isThisBrowser(r, unlocked.deviceRecipient)}
				<div
					class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 last:border-b-0"
					data-testid="history-key-way"
					data-kind={r.kind}
				>
					<div class="flex min-w-0 items-center gap-2.5">
						{#if r.kind === 'recovery'}
							<RiKey2Line class="size-4 flex-none" />
						{:else if r.kind === 'passkey'}
							<RiFingerprintLine class="size-4 flex-none" />
						{:else}
							<RiComputerLine class="size-4 flex-none" />
						{/if}
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{r.label}</div>
							<div class="type-caption text-fg-3">{kindLabel(r)}</div>
						</div>
					</div>
					{#if mine}
						<Button size="sm" casing="sentence" disabled={!!busy} onclick={forget}>
							<RiDeleteBinLine aria-hidden="true" />
							<span>{busy === 'forget' ? 'Forgetting…' : 'Forget this browser'}</span>
						</Button>
					{:else}
						<Button size="sm" casing="sentence" disabled={!!busy} onclick={() => remove(r)}>
							<RiDeleteBinLine aria-hidden="true" />
							<span>{busy === `remove:${wayId(r)}` ? 'Removing…' : 'Remove'}</span>
						</Button>
					{/if}
				</div>
			{/each}
			<div class="flex flex-wrap gap-2 px-3 py-3">
				<Button size="sm" casing="sentence" disabled={!!busy} onclick={() => (addingRecovery = true)}>
					<RiAddLine aria-hidden="true" />
					<span>Add a recovery key</span>
				</Button>
				{#if passkeyAvailable}
					<Button size="sm" casing="sentence" disabled={!!busy} onclick={addPasskey}>
						<RiAddLine aria-hidden="true" />
						<span>{busy === 'add-passkey' ? 'Waiting for your device…' : 'Add a passkey'}</span>
					</Button>
				{/if}
			</div>
		{/if}
		{#if actionError}
			<p class="border-t border-line-surface px-3 py-3 type-caption text-fg-1" role="alert">{actionError}</p>
		{/if}
	</Surface>
</section>

{#if addingRecovery}
	<Dialog.Root
		open={true}
		onOpenChange={(next) => {
			if (!next && busy !== 'add-recovery') addingRecovery = false;
		}}
	>
		<Dialog.Portal>
			<Dialog.Backdrop />
			<Dialog.Popup size="sm" data-testid="history-key-add-recovery">
				<Stack gap="4">
					<Dialog.Title>Add a recovery key</Dialog.Title>
					<RecoveryKeyMaker
						busy={busy === 'add-recovery'}
						cancelLabel="Cancel"
						oncancel={() => (addingRecovery = false)}
						onconfirmed={addRecovery}
					/>
				</Stack>
			</Dialog.Popup>
		</Dialog.Portal>
	</Dialog.Root>
{/if}

{#if optingIn && keyState?.kind === 'none'}
	<HistoryKeyOptIn
		{api}
		{owner}
		onclose={() => (optingIn = false)}
		ondone={(next) => {
			// The readers open sealed chats with it straight away, without a reload.
			historyKeyring.hold(owner, next.unlocked.identity);
			keyState = next;
			justTurnedOn = { existingChats: next.existingChats };
			optingIn = false;
		}}
		onconflict={() => {
			optingIn = false;
			keyState = null;
			void load();
		}}
	/>
{/if}

{#if unlocking && keyState?.kind === 'locked'}
	<HistoryKeyUnlockPrompt
		{api}
		{owner}
		stored={keyState.stored}
		deviceLabel={thisDeviceLabel()}
		ondone={(next) => {
			keyState = next;
			unlocking = false;
		}}
		ondismiss={() => (unlocking = false)}
	/>
{/if}
