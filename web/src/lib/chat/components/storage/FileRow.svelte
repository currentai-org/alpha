<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiFileTextLine from '~icons/ri/file-text-line';
	import RiImageLine from '~icons/ri/image-line';
	import RiFilePdf2Line from '~icons/ri/file-pdf-2-line';
	import RiChat3Line from '~icons/ri/chat-3-line';
	import RiDownloadLine from '~icons/ri/download-line';
	import RiFileTransferLine from '~icons/ri/file-transfer-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiErrorWarningFill from '~icons/ri/error-warning-fill';
	import { Button } from '@aipotluck/alpha-ds';
	import { imageObjectUrl, previewKind } from './previewKind';

	// CUR-1276, from files-components.jsx's FileRow. Delete is set apart at the far end with an
	// Accent 2 glyph and its own aria-label — a redundant signal beyond colour, since fill vs line is
	// not one everyone reads. status is client-only bookkeeping: the server has no notion of
	// "uploading" or "error", only files that made it into a listing or didn't.

	interface Props {
		name: string;
		size: string;
		status?: 'stored' | 'uploading' | 'error';
		progress?: number;
		error?: string;
		recovery?: 'retry' | 'remove';
		busy?: string;
		onDelete?: () => void;
		onCancel?: () => void;
		onRetry?: () => void;
		onRemove?: () => void;
		onDownload?: () => void;
		/** Copy or move to another location. No button when there is nowhere else to go. (CUR-2931) */
		onTransfer?: () => void;
		/** When the bucket took the file, as an ISO timestamp. (CUR-3289) */
		added?: string;
		/** The chat a file attached in chat came from. (CUR-3289) */
		chatHref?: string;
		/** The file's bytes, fetched for a thumbnail once the row scrolls into view. (CUR-3289) */
		thumbnailUrl?: string;
		/** Open the file in place. The thumbnail and the name both do it. (CUR-3289) */
		onOpen?: () => void;
	}
	let {
		name,
		size,
		status = 'stored',
		progress = 0,
		error,
		recovery,
		busy,
		onDelete,
		onCancel,
		onRetry,
		onRemove,
		onDownload,
		onTransfer,
		added,
		chatHref,
		thumbnailUrl,
		onOpen,
	}: Props = $props();

	let thumbEl = $state<HTMLElement>();
	let thumbSrc = $state<string | null>(null);
	$effect(() => {
		const kind = previewKind(name);
		if (!thumbnailUrl || kind.kind !== 'image' || !thumbEl) return;
		const url = thumbnailUrl;
		const controller = new AbortController();
		let made: string | null = null;
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			observer.disconnect();
			imageObjectUrl(url, kind.type, controller.signal).then((src) => {
				if (controller.signal.aborted) {
					if (src) URL.revokeObjectURL(src);
					return;
				}
				made = src;
				thumbSrc = src;
			});
		});
		observer.observe(thumbEl);
		return () => {
			observer.disconnect();
			controller.abort();
			if (made) URL.revokeObjectURL(made);
			thumbSrc = null;
		};
	});

	const uploading = $derived(status === 'uploading');
	const bad = $derived(status === 'error');

	// A fixed locale so the server render and the browser agree on the text.
	const addedLabel = $derived.by(() => {
		const t = added ? Date.parse(added) : NaN;
		return Number.isNaN(t)
			? null
			: `Added ${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
	});
	// The icon goes by extension only; the server sniffs the real type on upload (custodialUpload.ts).
	const ext = $derived(name.split('.').pop()?.toLowerCase() ?? '');
	const TypeIcon = $derived(
		['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic'].includes(ext)
			? RiImageLine
			: ext === 'pdf'
				? RiFilePdf2Line
				: RiFileTextLine,
	);
</script>

<div
	data-file-row
	class="flex flex-col gap-2 rounded-sharp border p-2.5
		{bad ? 'border-[var(--ap-ink)]' : 'border-[var(--ap-border-3)]'}
		bg-[var(--ap-stack-panel,var(--ap-paper))]"
>
	<div class="flex items-center gap-3">
		<span bind:this={thumbEl} data-file-kind={TypeIcon === RiFilePdf2Line ? 'pdf' : TypeIcon === RiImageLine ? 'image' : 'document'} class="grid size-10 shrink-0 place-items-center overflow-hidden rounded-sharp">
			{#if thumbSrc}
				<img src={thumbSrc} alt="" data-file-thumbnail class="size-full object-cover" />
			{:else}
				<TypeIcon class="size-4 text-fg-2" />
			{/if}
		</span>
		<span class="min-w-0 flex-1">
			{#if onOpen}
				<button
					type="button"
					title={name}
					aria-label={`Open ${name}`}
					onclick={onOpen}
					class="block max-w-full cursor-pointer overflow-hidden text-left type-body text-ellipsis whitespace-nowrap text-fg-1 hover:underline"
				>
					{name}
				</button>
			{:else}
				<span title={name} class="block overflow-hidden type-body text-ellipsis whitespace-nowrap text-fg-1">
					{name}
				</span>
			{/if}
			<span class="mt-0.5 block font-sans text-[12px] text-[var(--ap-ink-3)]">
				{size}{uploading ? ` · ${m.storage_uploading({ percent: progress })}` : busy ? ` · ${busy}` : ''}
			</span>
			{#if addedLabel || chatHref}
				<span class="mt-0.5 flex flex-wrap items-center gap-x-2 type-caption text-fg-3">
					{#if addedLabel}<span title={added}>{addedLabel}</span>{/if}
					{#if chatHref}
						<a
							href={chatHref}
							aria-label={`Open the chat ${name} came from`}
							class="inline-flex items-center gap-1 text-fg-2 underline underline-offset-2 hover:text-fg-1"
						>
							<RiChat3Line class="size-3.5" />From a chat
						</a>
					{/if}
				</span>
			{/if}
		</span>

		{#if uploading}
			<button
				type="button"
				onclick={onCancel}
				class="shrink-0 rounded-sharp border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] px-2.5 py-1 font-sans text-[12px] whitespace-nowrap text-[var(--ap-ink-2)]"
			>
				{m.message_cancel()}
			</button>
		{:else if bad && recovery === 'retry'}
			<button
				type="button"
				onclick={onRetry}
				class="shrink-0 rounded-sharp border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] px-2.5 py-1 font-sans text-[12px] whitespace-nowrap text-[var(--ap-ink)]"
			>
				{m.storage_tryAgain()}
			</button>
		{:else if bad && recovery === 'remove'}
			<button
				type="button"
				onclick={onRemove}
				class="shrink-0 rounded-sharp border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] px-2.5 py-1 font-sans text-[12px] whitespace-nowrap text-[var(--ap-ink)]"
			>
				{m.account_remove()}
			</button>
		{:else if !uploading && !bad}
			<span class="ml-3 flex shrink-0 items-center gap-2">
				<button
					type="button"
					aria-label={m.storage_downloadName({ name })}
					title={m.storage_downloadName({ name })}
					disabled={!!busy}
					onclick={onDownload}
					class="grid size-[30px] place-items-center rounded-sharp text-[var(--ap-ink-2)] hover:bg-[var(--ap-ink)]/5 disabled:opacity-40"
				>
					<RiDownloadLine class="size-4" />
				</button>
				{#if onTransfer}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.storage_copyOrMove({ name })}
						title={m.storage_copyOrMove({ name })}
						disabled={!!busy}
						onclick={onTransfer}
					>
						<RiFileTransferLine class="size-4" />
					</Button>
				{/if}
				<button
					type="button"
					aria-label={m.storage_deleteName({ name })}
					title={m.storage_deleteName({ name })}
					disabled={!!busy}
					onclick={onDelete}
					class="grid size-[30px] place-items-center rounded-sharp text-[var(--ap-danger)] hover:bg-[var(--ap-ink)]/5 disabled:opacity-40"
				>
					<RiDeleteBinFill class="size-4" />
				</button>
			</span>
		{/if}
	</div>

	{#if uploading}
		<div
			role="progressbar"
			aria-valuenow={progress}
			aria-valuemin={0}
			aria-valuemax={100}
			class="h-1 overflow-hidden rounded-sharp bg-[var(--ap-ink)]/10"
		>
			<span class="block h-full bg-[var(--ap-accent-1)]" style={`width: ${progress}%`}></span>
		</div>
	{/if}

	{#if bad && error}
		<div class="flex items-start gap-2">
			<RiErrorWarningFill class="mt-0.5 size-3.5 shrink-0 text-[var(--ap-danger)]" />
			<span class="flex-1 font-sans text-[12px] leading-[18px] text-[var(--ap-ink-2)]">{error}</span>
		</div>
	{/if}
</div>
