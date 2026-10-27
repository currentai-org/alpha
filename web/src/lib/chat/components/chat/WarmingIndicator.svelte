<script lang="ts">
	import { elapsedSeconds } from "$lib/chat/utils/elapsed.svelte";

	// Reusable warming/loading indicator with cold-start escalation. Shows `label` while a dynamic-load
	// backend call is in flight, and escalates to `warmingLabel` once it crosses `coldThresholdS` seconds
	// — that escalation is the honest "this is a cold-start, not a hang" tell. One primitive for every
	// dynamic-load surface (read-aloud TTS Space, the second opinion, anything that can scale-to-zero).
	// Pure UI: the parent owns `active`; the timer self-manages and resets when inactive.
	interface Props {
		active: boolean;
		/** Shown immediately while loading. */
		label: string;
		/** Shown instead once past coldThresholdS (the cold-start escalation). Falls back to `label`. */
		warmingLabel?: string;
		coldThresholdS?: number;
		/** Append "· Ns" once cold, for long waits where a live counter reassures. */
		showSeconds?: boolean;
	}
	let { active, label, warmingLabel, coldThresholdS = 3, showSeconds = false }: Props = $props();

	const elapsed = elapsedSeconds(() => active);
	const cold = $derived(elapsed.value >= coldThresholdS);
	const text = $derived(cold && warmingLabel ? warmingLabel : label);
</script>

{#if active}
	<span
		class="inline-flex items-center gap-1.5 text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]"
		role="status"
		aria-live="polite"
	>
		<span
			class="relative -top-px size-[6px] shrink-0 animate-pulse rounded-full bg-[var(--ap-live)]"
		></span>
		<span
			>{text}{#if showSeconds && cold}
				· {elapsed.value}s{/if}</span
		>
	</span>
{/if}
