<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onDestroy } from "svelte";
	import RiFileCopyLine from "~icons/ri/file-copy-line";
	import RiCheckLine from "~icons/ri/check-line";

	// "Copy"/"Copied" text-labeled button (Remix icons, this file's own timeout-based flip) — a
	// distinct UX from CopyToClipBoardBtn.svelte (icon-only, tooltip, Carbon icon, haptics), not a
	// replacement for it. Extracted from the local-inference settings page, which had two identical
	// copies of this block (the install-command box and the pairing-JSON box) flagged by
	// audit:dup:check.
	interface Props {
		getText: () => string;
		class?: string;
		errorMessage?: string;
		onError?: (message: string) => void;
	}

	let {
		getText,
		class: className = "",
		errorMessage = m.local_copyFailed(),
		onError,
	}: Props = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function handleClick() {
		try {
			await navigator.clipboard.writeText(getText());
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 2000);
		} catch {
			onError?.(errorMessage);
		}
	}

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

<button type="button" onclick={handleClick} class={className}>
	{#if copied}
		<RiCheckLine class="size-3.5 flex-none text-positive-text" />
		<span>{m.message_copied()}</span>
	{:else}
		<RiFileCopyLine class="size-3.5 flex-none" />
		<span>{m.message_copy()}</span>
	{/if}
</button>
