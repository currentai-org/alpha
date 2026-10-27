<!--
  @component
  Asks before a deep link sends a prompt or fetches attachments (CUR-2644, ported from upstream
  chat-ui 5418e752). Whoever wrote the link chose the text, the files and, on a model route, the
  model, so nothing happens until the visitor presses the confirming button.
-->
<script lang="ts">
	import { Button, Dialog, Inline, Stack } from '@aipotluck/alpha-ds';
	import type { LinkPromptRequest } from '$lib/chat/utils/linkParams';
	import RiSendPlaneFill from '~icons/ri/send-plane-fill';

	interface Props {
		request: LinkPromptRequest;
		/** The model the link picked, when it came through `/chat/models/<id>`. */
		modelName?: string;
		/** Load the attachments and, for a `q` link, send the prompt. */
		onconfirm: () => void;
		/** Drop the link's prompt and attachments entirely. */
		oncancel: () => void;
	}

	let { request, modelName, onconfirm, oncancel }: Props = $props();

	const hasAttachments = $derived(request.attachmentUrls.length > 0);
	const subject = $derived(
		request.send
			? hasAttachments
				? 'This prompt and its attachments come'
				: 'This prompt comes'
			: 'These attachments come'
	);
</script>

<!-- Opens with no click behind it, so the Cancel button comes first and takes the initial focus:
     a stray Enter must not send. Closing it any other way (Escape, the backdrop) cancels too. -->
<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) oncancel();
	}}
>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="sm" data-testid="link-prompt-dialog">
			<Stack gap="4">
				<Dialog.Title>{request.send ? 'Send this prompt?' : 'Add these attachments?'}</Dialog.Title>
				<Dialog.Description>
					{subject} from whoever shared this link. Only continue if you trust them.
					{#if request.send}
						Once sent, it goes out from your account and stays in your history.
					{/if}
				</Dialog.Description>

				{#if request.prompt}
					<Stack gap="1">
						<span class="text-micro text-fg-2">
							{request.send ? 'Prompt' : 'Prompt, placed in the composer without sending'}
						</span>
						<!-- Plain text on purpose: rendered markdown is how a payload hides behind a friendly heading. -->
						<pre
							class="max-h-48 overflow-y-auto rounded-sharp border border-line-2 bg-surface-2 px-3 py-2 font-mono text-micro break-words whitespace-pre-wrap text-fg-1">{request.prompt}</pre>
					</Stack>
				{/if}

				{#if hasAttachments}
					<Stack gap="1">
						<span class="text-micro text-fg-2">
							{request.attachmentUrls.length === 1 ? 'Attachment' : 'Attachments'}
						</span>
						<ul class="flex max-h-32 flex-col gap-1 overflow-y-auto">
							{#each request.attachmentUrls as url (url.href)}
								<!-- Built from URL parts with the host emphasized, so what is shown is exactly what is fetched. -->
								<li
									class="rounded-sharp border border-line-2 bg-surface-2 px-3 py-2 font-mono text-micro break-all text-fg-2"
								>
									{url.protocol}//<strong class="text-fg-1">{url.host}</strong>{url.pathname +
										url.search +
										url.hash}
								</li>
							{/each}
						</ul>
					</Stack>
				{/if}

				{#if modelName}
					<span class="text-micro text-fg-2">Model: <strong class="text-fg-1">{modelName}</strong></span>
				{/if}

				<Inline justify="end" gap="2">
					<Dialog.Close>Cancel</Dialog.Close>
					<Button onclick={onconfirm}>
						{#if request.send}<RiSendPlaneFill /> Send{:else}Add attachments{/if}
					</Button>
				</Inline>
			</Stack>
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
