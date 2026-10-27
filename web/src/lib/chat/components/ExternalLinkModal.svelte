<script lang="ts">
	import Modal from "$lib/chat/components/Modal.svelte";

	import CarbonClose from "~icons/carbon/close";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";

	interface Props {
		/** Must already be validated by the caller (parseExternalUrl): http(s) only, no userinfo */
		url: URL;
		onclose?: () => void;
	}

	let { url, onclose }: Props = $props();

	function close() {
		onclose?.();
	}

	function confirmOpen() {
		window.open(url.href, "_blank", "noopener,noreferrer");
		close();
	}

	// Unlike user-initiated confirm dialogs, this one is triggered by untrusted
	// preview content, so the confirm button is deliberately NOT auto-focused: a
	// modal popping up mid-typing must not let a stray Enter open the link.
</script>

<Modal onclose={close} width="w-[90dvh] md:w-[480px]">
	<div class="flex w-full flex-col gap-5 p-6">
		<div class="flex items-start justify-between">
			<h2 class="text-xl font-semibold text-fg-1">Open external link?</h2>
			<button type="button" class="group outline-hidden" onclick={close} aria-label="Close">
				<CarbonClose
					class="size-5 text-fg-2 group-hover:text-fg-1"
				/>
			</button>
		</div>

		<p class="text-sm text-fg-2">
			This link leads outside of the preview and will open in a new tab. Only continue if you trust
			the destination.
		</p>

		<!-- Built from URL components (host has no userinfo ambiguity) so the
		     rendered string is byte-identical to the URL that window.open gets -->
		<p
			class="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-xs break-all text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
		>
			{url.protocol}//<span class="font-semibold text-fg-1">{url.host}</span
			>{url.pathname + url.search + url.hash}
		</p>

		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				class="inline-flex items-center rounded-xl border border-line-2 bg-surface-3 px-3 py-1.5 text-sm font-medium text-fg-1 shadow-sm outline-hidden hover:bg-tint-hover"
				onclick={close}
			>
				Cancel
			</button>
			<button
				type="button"
				class="inline-flex items-center gap-1.5 rounded-xl border border-transparent bg-inverse px-3 py-1.5 text-sm font-semibold text-fg-inverse hover:bg-inverse/90 focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-surface-3 focus:outline-hidden"
				onclick={confirmOpen}
			>
				Open link
				<CarbonArrowUpRight class="size-3.5" />
			</button>
		</div>
	</div>
</Modal>
