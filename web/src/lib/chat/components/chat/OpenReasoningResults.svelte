<script lang="ts">
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import BlockWrapper from "./BlockWrapper.svelte";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import type { UnrunCodeReason } from "$lib/chat/types/MessageUpdate";
	import { scrubFenceNarration, scrubFenceNonce } from "$lib/chat/utils/fenceTags";

	interface Props {
		content: string;
		loading?: boolean;
		/** Why this turn's answer is predicted rather than measured, when it is. Set from
		 *  message.unrunCode, which the agent endpoint emits from the SAME check that prepends the
		 *  "wrote files but never ran anything" caveat to the answer — so the header below and that
		 *  sentence cannot contradict each other. Undefined is the ordinary case; it is NOT a claim that (CUR-1341)
		 *  tools ran, and nothing here should read it as one. */
		unrunReason?: UnrunCodeReason;
	}

	let { content, loading = false, unrunReason = undefined }: Props = $props();
	// A reasoning model narrates the injection fence by its nonce; the visitor never reads it. (CUR-3164)
	// With the nonce gone, the sentence restating the fence ("wrapped in markers") goes too. (CUR-3945)
	let shown = $derived(scrubFenceNarration(scrubFenceNonce(content, loading), loading));
	// When the scrub leaves nothing, the reasoning was all our own prompt plumbing. A finished
	// turn then shows no panel, since an empty "Working" header promises reasoning there is none of. (CUR-3945)
	let hasContent = $derived(loading || shown.trim().length > 0);

	// Three header states, not two. "Computing…"/"Computed" are untouched — see the comment in the
	// markup for why that wording is deliberate. The third exists because BOTH of those assert the
	// output was computed, which is false on a turn whose answer opens with "This turn wrote files but
	// never ran anything, so any output shown below is predicted rather than measured." The header is
	// what a reader who never expands the block walks away with, so it was the louder of the two claims
	// and the wrong one (CUR-1341).
	//
	// "Predicted" borrows the caveat's own word rather than inventing a second vocabulary for the same
	// fact. A structural failure is a different claim — the run tried and did not finish, rather than
	// the agent overclaiming what it did — and gets its own label, matching the split the answer prefix
	// already makes between STRUCTURAL_FAILURE_NOTICE and UNRUN_CODE_NOTICE.
	// "Working" is the panel's label (CUR-2079). Every reasoning model's think block
	// renders here, and nothing in this component knows whether a tool ran, so "Computed" put a claim of
	// calculation over a plain capital-city answer. (CUR-3940)
	let headerLabel = $derived(
		loading
			? "Working…"
			: unrunReason === "service-verdict-structural"
				? "Did not finish"
				: unrunReason
					? "Predicted"
					: "Working"
	);
	let isOpen = $state(false);
	let wasLoading = $state(false);
	let initialized = $state(false);
	// Reactive size bindings (powered by ResizeObserver under the hood) — used
	// to apply the fade mask only when the streamed content actually overflows
	// the viewport, so short reasoning isn't unnecessarily faded at the top.
	let viewportHeight = $state(0);
	let contentHeight = $state(0);

	// Track loading transitions to auto-expand/collapse
	$effect(() => {
		if (!initialized) {
			initialized = true;
			if (loading) {
				isOpen = true;
				wasLoading = true;
				return;
			}
		}

		if (loading && !wasLoading) {
			isOpen = true;
		} else if (!loading && wasLoading) {
			isOpen = false;
		}
		wasLoading = loading;
	});
</script>

{#if hasContent}
<BlockWrapper>
	<!-- Header row -->
	<button
		type="button"
		class="group/header flex w-fit cursor-pointer items-center gap-1 text-left select-none focus:outline-hidden"
		onclick={() => (isOpen = !isOpen)}
		aria-label={isOpen ? "Collapse" : "Expand"}
	>
		<span
			class="text-[length:var(--ap-text-3)] font-medium transition-colors group-hover/header:text-[var(--ap-ink-2)] dark:group-hover/header:text-[var(--ap-ink-3)] {isOpen
				? 'text-[var(--ap-ink-2)]'
				: 'text-[var(--ap-ink-3)]'}"
			class:thinking-shimmer={loading}
		>
			<!-- "Working", not "Reasoning" or "Thinking" — the house non-anthropomorphic stance for
			     user-visible copy (CUR-2079). The internal type is still
			     MessageReasoningUpdate, and that mismatch is deliberate rather than an oversight to tidy
			     up. The ellipsis marks streaming because the header stays visible after the block
			     auto-collapses. The other two labels live in headerLabel above, which has the reasoning. -->
			{headerLabel}
		</span>
		<CarbonChevronRight
			class="size-3.5 transition-all duration-200 group-hover/header:text-[var(--ap-ink-2)] dark:group-hover/header:text-[var(--ap-ink-3)] {isOpen
				? 'rotate-90 text-[var(--ap-ink-2)]'
				: 'text-[var(--ap-ink-3)]'}"
		/>
	</button>

	<!-- Expandable content -->
	{#if isOpen}
		{#if loading}
			<!--
				Streaming view: fixed-height viewport, content bottom-aligned so newly
				arriving tokens stay visible while older lines scroll off the top behind
				a gradient fade. Works for any model output format (no parsing).
			-->
			<div
				bind:clientHeight={viewportHeight}
				class="thinking-viewport mt-2 flex max-h-56 flex-col justify-end overflow-hidden md:max-h-80"
				class:has-overflow={contentHeight > viewportHeight}
			>
				<div
					bind:clientHeight={contentHeight}
					class="prose prose-sm max-w-none text-sm leading-relaxed text-[var(--ap-ink-3)] *:first:mt-0 *:last:mb-0 dark:prose-invert"
				>
					<MarkdownRenderer content={shown} {loading} />
				</div>
			</div>
		{:else}
			<div
				class="prose prose-sm mt-2 max-w-none text-sm leading-relaxed text-[var(--ap-ink-3)] dark:prose-invert"
			>
				<MarkdownRenderer content={shown} {loading} />
			</div>
		{/if}
	{/if}
</BlockWrapper>
{/if}

<style>
	.thinking-viewport.has-overflow {
		-webkit-mask-image: linear-gradient(to bottom, transparent 0, black 48px);
		mask-image: linear-gradient(to bottom, transparent 0, black 48px);
	}
	/*
	 * Variant of router-shimmer (defined in main.css) — light mode inverted so
	 * the text reads dark with a brighter spot sweeping across, instead of
	 * medium-gray with darker edges. Dark mode keeps the same bright-spot
	 * behavior as router-shimmer.
	 */
	.thinking-shimmer {
		display: inline-block;
		background-image: linear-gradient(
			90deg,
			rgba(107, 114, 128, 1) 0%,
			rgba(107, 114, 128, 0.3) 50%,
			rgba(107, 114, 128, 1) 100%
		);
		background-size: 220% 100%;
		animation: router-shimmer 2.8s linear infinite;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
	}
	:global(.dark) .thinking-shimmer {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.15) 0%,
			rgba(255, 255, 255, 0.7) 50%,
			rgba(255, 255, 255, 0.15) 100%
		);
	}
</style>
