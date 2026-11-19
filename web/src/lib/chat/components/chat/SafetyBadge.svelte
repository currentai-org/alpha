<script lang="ts">
	import type { ModerationKind } from "$lib/chat/types/MessageUpdate";

	// The honest provenance line for a SAFETY DECLINE — shown in place of ProvenanceBadge
	// when a turn was stopped by the pre-screen before the model ran. The whole product
	// rests on honest provenance, so a declined message must NOT claim Apertus generated it:
	// it names the open safety classifier that actually made the call.
	interface Props {
		kind?: ModerationKind;
		// CURATED, public-safe rule name (resolved server-side). The raw Coop action code is NEVER passed
		// here — an unknown/unlabeled rule leaves this undefined and only the generic classifier copy shows.
		ruleLabel?: string | null;
		// When rendered inside ProvenanceTrace, the trace draws the spine node, so the
		// badge suppresses its own leading dot to avoid a doubled marker.
		traced?: boolean;
		// The screen could not run (fail-closed UNKNOWN): nothing was flagged, so the badge must not
		// name a classifier that never returned a verdict.
		unscreened?: boolean;
	}
	// Default routes to the generic "open safety classifier" copy below (a safe fallback that
	// names no specific tier); real renders always pass an explicit kind from message.moderation.
	let { kind = "toxicity", ruleLabel, traced = false, unscreened = false }: Props = $props();

	let source = $derived(
		kind === "child_safety"
			? "child-safety classifier"
			: // Nothing emits "prompt_injection": an injection-shaped decline arrives as "content_policy".
				// "prompt_injection" maps to the same honest copy, so a stray caller cannot
				// reference a classifier that does not exist.
				kind === "prompt_injection" || kind === "content_policy"
					? "open content-safety policy"
					: "open safety classifier"
	);
</script>

<div
	class="{traced
		? ''
		: 'mt-1.5'} flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[length:var(--ap-text-1)] text-[var(--ap-ink-3)]"
	title={unscreened
		? "The safety check didn't finish, so this message was held back unchecked — the model did not generate this response."
		: `Declined by an open safety classifier before the model ran — the model did not generate this response.${ruleLabel
				? ` Policy: ${ruleLabel}.`
				: ''}`}
>
	{#if !traced}
		<!-- Dot + label as ONE flex item (not two): with the parent's flex-wrap, two separate
		     items let the label jump to its own line while the dot stays behind on the line
		     above — a flex layout can't wrap "into" an item, only "between" items. Bundling
		     them lets normal inline text flow wrap the label while the dot stays put beside line 1. -->
		<span>
			<span
				class="inline-block size-[6px] rounded-full align-middle"
				style="background: var(--ap-gap)"
			></span>
			<span class="ml-2">{unscreened ? "Couldn't check this message" : `Flagged by ${source}`}</span>
		</span>
	{:else}
		<span>{unscreened ? "Couldn't check this message" : `Flagged by ${source}`}</span>
	{/if}
</div>
