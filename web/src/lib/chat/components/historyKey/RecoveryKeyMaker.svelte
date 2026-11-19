<!--
  @component
  Makes a recovery key, shows it once with a download and a copy, then asks for it typed back before
  handing it on. It names it a recovery key, offers a download and a copy for a password manager, and requires it
  typed back. Used by the recovery step and by Settings → Your key.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, Field, Inline, Stack } from '@aipotluck/alpha-ds';
	import RiDownload2Line from '~icons/ri/download-2-line';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import { generateRecoveryKey } from '$lib/chat/crypto/historyIdentity';
	import { recoveryKeyMatches } from '$lib/chat/crypto/historyKeyClient';
	import { downloadBlob } from '$lib/chat/utils/downloadBlob';

	let {
		busy = false,
		onconfirmed,
		oncancel,
		cancelLabel = 'Back'
	}: {
		/** The caller is storing what it was handed; the buttons wait. */
		busy?: boolean;
		/** The key was typed back correctly. `recipient` goes in the wrap; `recoveryKey` is never kept. */
		onconfirmed: (made: { recoveryKey: string; recipient: string }) => void;
		oncancel?: () => void;
		cancelLabel?: string;
	} = $props();

	let made = $state<{ recoveryKey: string; recipient: string } | null>(null);
	let step = $state<'show' | 'confirm'>('show');
	let typed = $state('');
	let copied = $state(false);
	let mismatch = $state(false);
	let failed = $state('');

	onMount(() => {
		generateRecoveryKey().then(
			(k) => (made = k),
			(e) => {
				console.error('[history-key] could not make a recovery key', e);
				failed = 'This browser could not make a recovery key.';
			}
		);
	});

	function download() {
		if (!made) return;
		const text = [
			'AI Potluck recovery key',
			'',
			made.recoveryKey,
			'',
			'This key opens your AI Potluck chat history if you lose access in every browser you use.',
			'Keep it somewhere safe, such as a password manager. AI Potluck cannot recover it for you.',
			''
		].join('\n');
		downloadBlob(new Blob([text], { type: 'text/plain' }), 'ai-potluck-recovery-key.txt');
	}

	async function copy() {
		if (!made) return;
		try {
			await navigator.clipboard.writeText(made.recoveryKey);
			copied = true;
		} catch {
			copied = false;
		}
	}

	function confirm(event: SubmitEvent) {
		event.preventDefault();
		if (!made) return;
		if (!recoveryKeyMatches(made.recoveryKey, typed)) {
			mismatch = true;
			return;
		}
		onconfirmed(made);
	}
</script>

{#if failed}
	<p class="type-caption text-fg-1" role="alert">{failed}</p>
{:else if step === 'show'}
	<Stack gap="3" data-testid="recovery-key-show">
		<p class="type-body text-fg-2">
			This is your recovery key. It is shown once. Save it somewhere safe, such as a password
			manager. Anyone who has it can open your chat history, and we can't give you a new copy.
		</p>
		<code
			class="block rounded-sharp border border-line-2 bg-surface-2 px-3 py-2 font-mono text-micro break-all text-fg-1 select-all"
			data-testid="recovery-key-value">{made?.recoveryKey ?? '…'}</code
		>
		<Inline gap="2" wrap>
			<Button size="sm" casing="sentence" disabled={!made} onclick={download}>
				<RiDownload2Line aria-hidden="true" />
				<span>Download</span>
			</Button>
			<Button size="sm" casing="sentence" disabled={!made} onclick={copy}>
				<RiFileCopyLine aria-hidden="true" />
				<span>{copied ? 'Copied' : 'Copy'}</span>
			</Button>
		</Inline>
		<Inline justify="end" gap="2">
			{#if oncancel}
				<Button casing="sentence" onclick={oncancel}>{cancelLabel}</Button>
			{/if}
			<Button variant="primary" casing="sentence" disabled={!made} onclick={() => (step = 'confirm')}>
				I've saved it
			</Button>
		</Inline>
	</Stack>
{:else}
	<form class="contents" onsubmit={confirm}>
		<Stack gap="3" data-testid="recovery-key-confirm">
			<Field.Root invalid={mismatch}>
				<Field.Label>Type or paste your recovery key</Field.Label>
				<Field.Control
					bind:value={typed}
					autocomplete="off"
					spellcheck="false"
					oninput={() => (mismatch = false)}
				/>
				<Field.Description>So we know it was saved before we rely on it.</Field.Description>
				<Field.Error>That doesn't match the key shown. Check it and try again.</Field.Error>
			</Field.Root>
			<Inline justify="end" gap="2">
				<Button casing="sentence" disabled={busy} onclick={() => (step = 'show')}>Show it again</Button>
				<Button type="submit" variant="primary" casing="sentence" disabled={busy || !typed.trim()}>
					{busy ? 'Saving…' : 'Confirm recovery key'}
				</Button>
			</Inline>
		</Stack>
	</form>
{/if}
