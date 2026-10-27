<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import RiErrorWarningFill from '~icons/ri/error-warning-fill';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';

	// CUR-1276. Focus opens on Cancel (not Delete — a default focus on the destructive action
	// invites an accidental delete); Escape cancels unless a delete is in flight.
	// The destructive action keeps a Border 2 outline and a Text 1 label with only its glyph in
	// Accent 2 — this design system has no accent-filled button (see design-system.md).

	interface Props {
		name: string;
		busy?: boolean;
		error?: string;
		onConfirm: () => void;
		onCancel: () => void;
	}
	let { name, busy = false, error, onConfirm, onCancel }: Props = $props();

	let cancelEl: HTMLButtonElement;

	onMount(() => {
		cancelEl?.focus();
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape' && !busy) onCancel();
		}
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	});
</script>

<div
	role="dialog"
	aria-modal="true"
	aria-labelledby="confirm-delete-title"
	class="absolute inset-0 z-50 flex items-center justify-center bg-[var(--ap-ink)]/40 p-5 backdrop-blur-sm"
>
	<div
		class="flex max-w-[380px] flex-col gap-3 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] p-5"
	>
		<h2 id="confirm-delete-title" class="m-0 font-sans text-[16px] font-bold text-[var(--ap-ink)]">
			{m.storage_deleteTitle()}
		</h2>
		<p class="m-0 font-sans text-[13px] leading-[18px] text-[var(--ap-ink-2)]">
			{#each m.storage_deleteBody({ name: "{name}" }).split(/(\{name\})/).filter(Boolean) as part, i (i)}{#if part === "{name}"}<span class="text-[var(--ap-ink)]">{name}</span>{:else}{part}{/if}{/each}
		</p>
		{#if error}
			<div class="flex items-start gap-2">
				<RiErrorWarningFill class="mt-0.5 size-3.5 shrink-0 text-[var(--ap-danger)]" />
				<span class="font-sans text-[13px] leading-[18px] text-[var(--ap-ink-2)]">{error}</span>
			</div>
		{/if}
		<div class="mt-2 flex gap-2">
			<button
				bind:this={cancelEl}
				type="button"
				disabled={busy}
				onclick={onCancel}
				class="rounded-[var(--ap-radius-1)] border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-1.5 font-sans text-[13px] text-[var(--ap-ink)] disabled:opacity-40"
			>
				{m.message_cancel()}
			</button>
			<span class="flex-1"></span>
			<button
				type="button"
				disabled={busy}
				onclick={onConfirm}
				class="flex items-center gap-1.5 rounded-[var(--ap-radius-1)] border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-1.5 font-sans text-[13px] text-[var(--ap-ink)] disabled:opacity-60"
			>
				<RiDeleteBinFill class="size-3.5 text-[var(--ap-danger)]" />
				{busy ? m.workspace_deleting() : error ? m.storage_tryAgain() : m.settings_delete()}
			</button>
		</div>
	</div>
</div>
