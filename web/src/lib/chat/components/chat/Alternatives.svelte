<script lang="ts">
	import type { Message } from "$lib/chat/types/Message";
	import CarbonChevronLeft from "~icons/carbon/chevron-left";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import { m } from "$lib/paraglide/messages.js";

	interface Props {
		message: Message;
		alternatives?: Message["id"][];
		loading?: boolean;
		classNames?: string;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
	}

	let {
		message,
		alternatives = [],
		loading = false,
		classNames = "",
		onshowAlternateMsg,
	}: Props = $props();

	let currentIdx = $derived(alternatives.findIndex((id) => id === message.id));

	// API client removed as deletion UI is commented out
</script>

<div
	class="font-white group/navbranch z-0 flex h-6 w-fit items-center justify-center gap-1 text-[length:var(--ap-text-2)] whitespace-nowrap select-none {classNames}"
>
	<button
		type="button"
		aria-label={m.message_previousVersion()}
		class="inline text-[length:var(--ap-text-4)] font-thin text-[var(--ap-ink-3)] hover:text-[var(--ap-ink)] disabled:pointer-events-none disabled:opacity-25"
		onclick={() => onshowAlternateMsg?.({ id: alternatives[Math.max(0, currentIdx - 1)] })}
		disabled={currentIdx === 0 || loading}
	>
		<CarbonChevronLeft class="text-[length:var(--ap-text-3)]" />
	</button>
	<span class=" text-[var(--ap-ink-3)]">
		{currentIdx + 1} / {alternatives.length}
	</span>
	<button
		type="button"
		aria-label={m.message_nextVersion()}
		class="inline text-[length:var(--ap-text-4)] font-thin text-[var(--ap-ink-3)] hover:text-[var(--ap-ink)] disabled:pointer-events-none disabled:opacity-25"
		onclick={() =>
			onshowAlternateMsg?.({
				id: alternatives[Math.min(alternatives.length - 1, currentIdx + 1)],
			})}
		disabled={currentIdx === alternatives.length - 1 || loading}
	>
		<CarbonChevronRight class="text-[length:var(--ap-text-3)]" />
	</button>
</div>
