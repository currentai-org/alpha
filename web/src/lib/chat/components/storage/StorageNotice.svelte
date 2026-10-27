<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiCheckLine from '~icons/ri/check-line';
	import RiErrorWarningFill from '~icons/ri/error-warning-fill';
	import RiCloseLine from '~icons/ri/close-line';

	// CUR-1276, from files-components.jsx's Notice. Panel-level feedback for actions that finish
	// after their row is gone (delete) or that never had a row (download) — dismissible, flat, sharp
	// corners.
	interface Props {
		tone?: 'ok' | 'error';
		text: string;
		actionLabel?: string;
		onAction?: () => void;
		onDismiss: () => void;
	}
	let { tone = 'ok', text, actionLabel, onAction, onDismiss }: Props = $props();
	const bad = $derived(tone === 'error');
</script>

<div
	role="status"
	class="flex items-start gap-2 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-3)] bg-[var(--ap-paper-2)] px-3 py-2.5"
>
	{#if bad}
		<RiErrorWarningFill class="mt-0.5 size-3.5 shrink-0 text-[var(--ap-danger)]" />
	{:else}
		<RiCheckLine class="mt-0.5 size-3.5 shrink-0 text-[var(--ap-ink)]" />
	{/if}
	<span class="flex-1 font-sans text-[13px] leading-[18px] text-[var(--ap-ink-2)]">{text}</span>
	{#if actionLabel}
		<button
			type="button"
			onclick={onAction}
			class="rounded-[var(--ap-radius-1)] border border-[var(--ap-border-3)] bg-[var(--ap-stack-panel,var(--ap-paper))] px-2 py-1 font-sans text-[12px] text-[var(--ap-ink)]"
		>
			{actionLabel}
		</button>
	{/if}
	<button
		type="button"
		aria-label={m.chat_dismiss()}
		onclick={onDismiss}
		class="grid size-[22px] shrink-0 place-items-center text-[var(--ap-ink-3)]"
	>
		<RiCloseLine class="size-3.5" />
	</button>
</div>
