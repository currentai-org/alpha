<script lang="ts">
	import RiChat3Line from '~icons/ri/chat-3-line';
	import { Button, Dialog, Inline } from '@aipotluck/alpha-ds';
	import { imageObjectUrl, previewKind, TEXT_PREVIEW_BYTES } from './previewKind';

	// Clicking a My files row opens the file here instead of downloading it. Images and
	// plain text are drawn in place (previewKind.ts says why that is safe); anything else says so
	// and offers the download. (CUR-3289)
	interface Props {
		open?: boolean;
		name: string;
		fileUrl: string;
		chatHref?: string;
		onDownload: () => void;
	}
	let { open = $bindable(false), name, fileUrl, chatHref, onDownload }: Props = $props();

	const kind = $derived(previewKind(name));
	let imageUrl = $state<string | null>(null);
	let text = $state<string | null>(null);
	let truncated = $state(false);
	let failed = $state(false);

	$effect(() => {
		if (!open || kind.kind === 'none') return;
		const controller = new AbortController();
		let url: string | null = null;
		failed = false;
		imageUrl = null;
		text = null;
		(async () => {
			if (kind.kind === 'image') {
				url = await imageObjectUrl(fileUrl, kind.type, controller.signal);
				if (controller.signal.aborted) return;
				if (url) imageUrl = url;
				else failed = true;
				return;
			}
			const res = await fetch(fileUrl, { signal: controller.signal }).catch(() => null);
			const bytes = res?.ok ? await res.arrayBuffer().catch(() => null) : null;
			if (controller.signal.aborted) return;
			if (!bytes) {
				failed = true;
				return;
			}
			truncated = bytes.byteLength > TEXT_PREVIEW_BYTES;
			text = new TextDecoder().decode(bytes.slice(0, TEXT_PREVIEW_BYTES));
		})();
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Backdrop />
		<Dialog.Popup size="lg" data-testid="file-preview">
			<Dialog.Title>{name}</Dialog.Title>
			<div class="flex flex-col gap-4">
				{#if kind.kind === 'none'}
					<p class="m-0 type-body text-fg-2">This kind of file can't be shown here yet. Download it to open it.</p>
				{:else if failed}
					<p class="m-0 type-body text-fg-2" role="alert">This file couldn't be loaded. Try again, or download it.</p>
				{:else if imageUrl}
					<img src={imageUrl} alt={name} class="max-h-96 w-full object-contain" />
				{:else if text !== null}
					<pre
						class="m-0 max-h-96 overflow-auto whitespace-pre-wrap type-caption text-fg-1">{text}</pre>
					{#if truncated}
						<p class="m-0 type-caption text-fg-3">Showing the first 64 KB. Download it for the rest.</p>
					{/if}
				{:else}
					<p class="m-0 type-caption text-fg-3">Loading…</p>
				{/if}
				<Inline justify="end" gap="2">
					{#if chatHref}
						<a href={chatHref} class="inline-flex items-center gap-1 type-caption text-fg-2 underline underline-offset-2">
							<RiChat3Line class="size-3.5" />Open the chat it came from
						</a>
					{/if}
					<span class="flex-1"></span>
					<Button variant="secondary" onclick={onDownload}>Download</Button>
				</Inline>
			</div>
			<Dialog.Close />
		</Dialog.Popup>
	</Dialog.Portal>
</Dialog.Root>
