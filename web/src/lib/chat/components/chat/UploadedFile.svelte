<script lang="ts">
	import { page } from "$app/state";
	import type { MessageFile } from "$lib/chat/types/Message";
	import CarbonClose from "~icons/carbon/close";
	import CarbonDocument from "~icons/carbon/document";
	import RiFileLine from "~icons/ri/file-line";
	import RiFilePdf2Line from "~icons/ri/file-pdf-2-line";
	import RiFileTextLine from "~icons/ri/file-text-line";
	import RiFileWord2Line from "~icons/ri/file-word-2-line";
	import RiClipboardLine from "~icons/ri/clipboard-line";
	import { Attachment } from "@aipotluck/alpha-ds";
	import Modal from "../Modal.svelte";
	import AudioPlayer from "../players/AudioPlayer.svelte";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import { base } from "$lib/chat/paths";
	import { TEXT_MIME_ALLOWLIST } from "$lib/chat/constants/mime";
	import { fileTypeLabel } from "$lib/chat/utils/fileTypeLabel";
	import { rememberSentFile, sentFilePreview } from "$lib/chat/utils/sentFilePreviews";

	interface Props {
		file: MessageFile;
		canClose?: boolean;
		onclose?: () => void;
	}

	let { file, canClose = true, onclose }: Props = $props();

	let showModal = $state(false);

	// Capture URL once at component creation to prevent reactive updates during navigation
	let urlNotTrailing = page.url.pathname.replace(/\/$/, "");

	function truncateMiddle(text: string, maxLength: number): string {
		if (text.length <= maxLength) {
			return text;
		}

		const halfLength = Math.floor((maxLength - 1) / 2);
		const start = text.substring(0, halfLength);
		const end = text.substring(text.length - halfLength);

		return `${start}…${end}`;
	}

	const isImage = (mime: string) =>
		mime.startsWith("image/") || mime === "webp" || mime === "jpeg" || mime === "png";

	// An image this browser attached is drawn from its own copy, before and after the
	// turn-end reload turns it into a stored reference, so the thumbnail never drops out. (CUR-2761)
	const imageSrc = $derived(
		file.type === "base64"
			? `data:${file.mime};base64,${file.value}`
			: (sentFilePreview(file.value) ?? urlNotTrailing + "/output/" + file.value)
	);
	$effect(() => {
		if (file.type === "base64" && isImage(file.mime)) void rememberSentFile(file.mime, file.value);
	});

	const isAudio = (mime: string) =>
		mime.startsWith("audio/") || mime === "mp3" || mime === "wav" || mime === "x-wav";
	const isVideo = (mime: string) =>
		mime.startsWith("video/") || mime === "mp4" || mime === "x-mpeg";

	function matchesAllowed(contentType: string, allowed: readonly string[]): boolean {
		const ct = contentType.split(";")[0]?.trim().toLowerCase();
		if (!ct) return false;
		const [ctType, ctSubtype] = ct.split("/");
		for (const a of allowed) {
			const [aType, aSubtype] = a.toLowerCase().split("/");
			const typeOk = aType === "*" || aType === ctType;
			const subOk = aSubtype === "*" || aSubtype === ctSubtype;
			if (typeOk && subOk) return true;
		}
		return false;
	}

	const isPlainText = (mime: string) =>
		mime === "application/vnd.chatui.clipboard" || matchesAllowed(mime, TEXT_MIME_ALLOWLIST);

	let isClickable = $derived(isImage(file.mime) || isPlainText(file.mime));

	const fileHref = $derived(
		file.type === "base64"
			? `data:${file.mime};base64,${file.value}`
			: urlNotTrailing + "/output/" + file.value
	);
	const isClipboard = $derived(file.mime === "application/vnd.chatui.clipboard");
	const isUnknown = $derived(file.mime === "application/octet-stream");
	const kindLabel = $derived(
		isClipboard ? "Pasted text" : isUnknown ? "Unknown type" : fileTypeLabel(file.mime, file.name)
	);
	const kindIcon = $derived(
		isClipboard
			? RiClipboardLine
			: file.mime === "application/pdf"
				? RiFilePdf2Line
				: file.mime.includes("wordprocessingml") || file.mime === "application/msword"
					? RiFileWord2Line
					: isPlainText(file.mime)
						? RiFileTextLine
						: RiFileLine
	);
	// A file whose type couldn't be worked out can't be previewed, so opening it downloads it.
	function download() {
		const link = document.createElement("a");
		link.href = fileHref;
		link.download = file.name;
		link.click();
	}
</script>

{#if showModal && isClickable}
	<!-- show the image file full screen, click outside to exit -->
	<Modal width="xl:max-w-[75dvw]" onclose={() => (showModal = false)}>
		{#if isImage(file.mime)}
			{#if file.type === "hash"}
				<img
					src={urlNotTrailing + "/output/" + file.value}
					alt="input from user"
					class="aspect-auto"
				/>
			{:else}
				<!-- handle the case where this is a base64 encoded image -->
				<img
					src={`data:${file.mime};base64,${file.value}`}
					alt="input from user"
					class="aspect-auto"
				/>
			{/if}
		{:else if isPlainText(file.mime)}
			<div class="relative flex h-full w-full flex-col gap-2 p-4">
				<!-- CUR-4668: one line, cut with an ellipsis, clear of the close button; the full name stays
				     in `title`, and the heading's text is the whole name for a screen reader. -->
				<div class="flex min-w-0 items-center gap-1 pr-8">
					<CarbonDocument class="shrink-0" />
					<h3 class="min-w-0 truncate text-lg font-semibold" title={file.name}>{file.name}</h3>
				</div>
				{#if file.mime === "application/vnd.chatui.clipboard"}
					<p class="text-sm text-gray-500">
						If you prefer to inject clipboard content directly in the chat, you can disable this
						feature in the
						<a href={`${base}/settings`} class="underline">settings page</a>.
					</p>
				{/if}
				<button
					class="absolute top-4 right-4 text-xl text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white"
					onclick={() => (showModal = false)}
				>
					<CarbonClose class="text-xl" />
				</button>
				{#if file.type === "hash"}
					{#await fetch(urlNotTrailing + "/output/" + file.value).then((res) => res.text())}
						<div class="flex h-full w-full items-center justify-center">
							<EosIconsLoading class="text-xl" />
						</div>
					{:then result}
						<pre
							class="w-full pt-0 text-xs wrap-break-word whitespace-pre-wrap"
							class:font-sans={file.mime === "text/plain" ||
								file.mime === "application/vnd.chatui.clipboard"}
							class:font-mono={file.mime !== "text/plain" &&
								file.mime !== "application/vnd.chatui.clipboard"}>{result}</pre>
					{/await}
				{:else}
					<pre
						class="w-full pt-0 text-xs wrap-break-word whitespace-pre-wrap"
						class:font-sans={file.mime === "text/plain" ||
							file.mime === "application/vnd.chatui.clipboard"}
						class:font-mono={file.mime !== "text/plain" &&
							file.mime !== "application/vnd.chatui.clipboard"}>{atob(file.value)}</pre>
				{/if}
			</div>
		{/if}
	</Modal>
{/if}

{#if isAudio(file.mime)}
	<AudioPlayer src={fileHref} name={truncateMiddle(file.name, 28)} />
{:else if isVideo(file.mime)}
	<div class="w-72 overflow-clip border border-line-surface bg-surface-raised rounded-card">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video src={fileHref} controls></video>
	</div>
{:else}
	<Attachment.Card
		name={file.name}
		kind={kindLabel}
		icon={kindIcon}
		imageSrc={isImage(file.mime) ? imageSrc : undefined}
		onopen={isClickable ? () => (showModal = true) : isUnknown ? download : undefined}
		openLabel={isClickable ? `Open ${file.name}` : isUnknown ? `Download ${file.name}` : undefined}
		onremove={canClose ? () => onclose?.() : undefined}
	/>
{/if}
