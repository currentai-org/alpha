<script lang="ts">
	import { onDestroy } from "svelte";
	import { confirm as hapticConfirm } from "$lib/chat/utils/haptics";
	import { CopyFeedback } from "$lib/chat/utils/copyFeedback.svelte";

	import CarbonCopy from "~icons/carbon/copy";
	import { m } from "$lib/paraglide/messages.js";
	import Tooltip from "./Tooltip.svelte";

	interface Props {
		classNames?: string;
		iconClassNames?: string;
		value: string;
		children?: import("svelte").Snippet;
		onClick?: () => void;
		showTooltip?: boolean;
	}

	let {
		classNames = "",
		iconClassNames = "",
		value,
		children,
		onClick,
		showTooltip = true,
	}: Props = $props();

	// A refused copy says so, as the answer footer's copy does (CUR-2823). (CUR-2920)
	const feedback = new CopyFeedback(1000);
	const copyState = $derived(feedback.state);

	const handleClick = async () => {
		try {
			if (await feedback.copy(value)) hapticConfirm();
		} catch (err) {
			console.error(err);
		}
	};

	onDestroy(() => feedback.dispose());
</script>

<button
	class={classNames}
	title={m.message_copyToClipboard()}
	type="button"
	onclick={() => {
		onClick?.();
		handleClick();
	}}
>
	<div class="relative">
		{#if children}{@render children()}{:else}
			<CarbonCopy class={iconClassNames} />
		{/if}

		{#if showTooltip}
			<Tooltip
				label={copyState === "failed" ? m.message_copyFailed() : m.message_copied()}
				classNames={copyState === "idle" ? "opacity-0" : "opacity-100"}
				hidden={copyState === "idle"}
			/>
		{/if}
	</div>
</button>
