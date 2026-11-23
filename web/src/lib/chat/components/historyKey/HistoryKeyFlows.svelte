<!--
  @component
  Enrolls and unlocks the conversation-history key in this browser (stage 2).
  Loaded by HistoryKeyGate only while layout data's `historyKeyEnabled` is on.

  - A guest gets a device key silently, the first time a conversation page shows (after the first turn),
    and an existing one opens on every page.
  - A signed-in account with no key on the server is asked nothing: encryption is a choice made in
    Settings → Account → Your key, and until then its turns are written as before.
  - A signed-in account whose key this browser cannot open meets the unlock prompt.

  The first visit also opens the welcome dialog, so the prompt waits until it has been seen (as
  LinkPromptGate does).

  Once the key opens, its identity goes to `historyKeyring` and the conversation reloads, so sealed
  messages and titles open in place. A locked placeholder's "Unlock" asks for the prompt
  again after "Not now" closed it.
-->
<script lang="ts">
	import { browser } from '$app/env';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { UrlDependency } from '$lib/chat/types/UrlDependency';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';
	import { showsClosedSealedParts } from '$lib/chat/crypto/sealedShape';
	import { useSettingsStore } from '$lib/chat/stores/settings.js';
	import { guestHistoryKeyState } from '$lib/chat/crypto/guestHistoryKey';
	import {
		historyKeyApi,
		historyKeyOwner,
		readHistoryKeyState,
		type HistoryKeyState
	} from '$lib/chat/crypto/historyKeyClient';
	import HistoryKeyUnlockPrompt from './HistoryKeyUnlockPrompt.svelte';
	import { thisDeviceLabel } from './historyKeyLabels';

	const settings = useSettingsStore();
	const api = historyKeyApi();

	const enabled = $derived(page.data.historyKeyEnabled === true);
	const userId = $derived<string | null>(page.data.user?.id ?? null);
	const onConversation = $derived(Boolean(page.params.id) && (page.route.id?.endsWith('/conversation/[id]') ?? false));

	let keyState = $state<HistoryKeyState | null>(null);
	let dismissed = $state(false);
	let checkedOwner = '';

	async function check(owner: string) {
		try {
			const next = await readHistoryKeyState(api, owner);
			if (checkedOwner === owner) keyState = next;
		} catch (e) {
			console.error('[history-key] could not read the history key', e);
		}
	}

	// The session's user changed without a reload (a sign-out, another account): never keep the last
	// one's identity, whatever the flows below go on to do.
	$effect(() => {
		if (!browser) return;
		historyKeyring.keepOnlyFor(historyKeyOwner(userId));
		if (!userId) checkedOwner = '';
	});

	$effect(() => {
		if (!browser || !enabled || !userId) return;
		const owner = historyKeyOwner(userId);
		if (checkedOwner === owner) return;
		checkedOwner = owner;
		keyState = null;
		historyKeyring.clear();
		dismissed = false;
		void check(owner);
	});

	$effect(() => {
		if (!browser || !enabled || userId) return;
		const guest = historyKeyOwner(null);
		// Made only on a conversation page; an existing key opens on every page, so the chat list and
		// Search chats can read sealed chats from the landing page too.
		guestHistoryKeyState(api, thisDeviceLabel(), onConversation)
			.then((state) => {
				if (state.kind === 'unlocked') hold(guest, state.unlocked.identity);
			})
			.catch((e) => console.error('[history-key] could not make the guest device key', e));
	});

	/** Hand the opened identity to the readers (sidebar titles reopen on their own), and reload the
	 *  conversation only when it shows a sealed part that did not open, so a guest's plaintext chat is
	 *  not fetched twice. */
	function hold(owner: string, identity: string) {
		if (historyKeyring.hold(owner, identity) && showsClosedSealedParts(page.data as Parameters<typeof showsClosedSealedParts>[0])) {
			void invalidate(UrlDependency.Conversation);
		}
	}

	$effect(() => {
		if (keyState?.kind === 'unlocked') hold(historyKeyOwner(userId), keyState.unlocked.identity);
	});

	// A locked placeholder's "Unlock" (SealedMessageNotice) reopens the prompt "Not now" closed.
	let seenAsks = historyKeyring.unlockAsks;
	$effect(() => {
		const asks = historyKeyring.unlockAsks;
		if (asks === seenAsks) return;
		seenAsks = asks;
		dismissed = false;
	});

	const owner = $derived(historyKeyOwner(userId));
	const ready = $derived(enabled && Boolean(userId) && $settings.welcomeModalSeen);
</script>

{#if ready && keyState?.kind === 'locked' && !dismissed}
	<HistoryKeyUnlockPrompt
		{api}
		{owner}
		stored={keyState.stored}
		deviceLabel={thisDeviceLabel()}
		ondone={(next) => (keyState = next)}
		ondismiss={() => (dismissed = true)}
	/>
{/if}
