<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { Button, Field, Inline, Stack } from '@aipotluck/alpha-ds';
	import { sendStorageJson } from './storageRequest';

	// Link a Hugging Face bucket the person already owns, with a token they create for it.
	// The token goes to our server once, is checked against Hugging Face, and is stored encrypted; it is
	// never shown again. The person's files stay in their bucket if they unlink. (CUR-2930)
	interface Props {
		/** Called with the new location's id, so the card can offer to move files there (CUR-2941). */
		onLinked: (id: string | undefined) => void;
	}
	let { onLinked }: Props = $props();

	let bucket = $state('');
	let folder = $state('');
	let token = $state('');
	let busy = $state(false);
	let message = $state<string | undefined>(undefined);

	const canSubmit = $derived(bucket.trim().length > 0 && token.trim().length > 0 && !busy);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		busy = true;
		message = undefined;
		try {
			const reply = await sendStorageJson('locations', 'POST', {
				bucket: bucket.trim(),
				folder: folder.trim(),
				token: token.trim(),
			});
			if (!reply) {
				message = m.storage_linkNetworkFailed();
				return;
			}
			if (!reply.ok) {
				message = reply.message ?? m.storage_linkFailedStatus({ status: reply.status });
				return;
			}
			bucket = '';
			folder = '';
			token = '';
			onLinked(reply.id);
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={submit} class="flex flex-col gap-3" data-testid="link-bucket-form">
	<Stack gap="3">
		<Field.Root>
			<Field.Label>{m.storage_bucket()}</Field.Label>
			<Field.Control bind:value={bucket} placeholder={m.storage_bucketPlaceholder()} autocomplete="off" />
			<Field.Description>{m.storage_bucketHelp()}</Field.Description>
		</Field.Root>
		<Field.Root>
			<Field.Label>{m.storage_folder()}</Field.Label>
			<Field.Control bind:value={folder} placeholder="alpha" autocomplete="off" />
			<Field.Description>{m.storage_folderHelp()}</Field.Description>
		</Field.Root>
		<Field.Root>
			<Field.Label>{m.storage_token()}</Field.Label>
			<Field.Control bind:value={token} type="password" autocomplete="off" />
			<Field.Description>
				{#each m.storage_tokenHelp({ link: "{link}" }).split(/(\{link\})/).filter(Boolean) as part, i (i)}{#if part === "{link}"}<a class="underline" href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer"
					>huggingface.co/settings/tokens</a
				>{:else}{part}{/if}{/each}
			</Field.Description>
		</Field.Root>
	</Stack>
	{#if message}
		<p class="m-0 text-small text-fg-1" role="alert" data-testid="link-bucket-error">{message}</p>
	{/if}
	<Inline justify="start">
		<Button type="submit" variant="primary" disabled={!canSubmit}>{busy ? m.storage_checking() : m.storage_linkBucket()}</Button>
	</Inline>
</form>
