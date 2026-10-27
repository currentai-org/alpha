<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import RiFileUploadLine from '~icons/ri/file-upload-line';

	// CUR-1276, from files-components.jsx's DropZone. Always visible — never revealed on hover or
	// drag, and the accepted types + size cap are stated before anyone picks a file. Radius 2 (10px):
	// same tier as the chat input, per the design's own note that both are "places you put content
	// in" — see design-system.md on when 10px applies.

	interface Props {
		accept: string;
		maxSize: string;
		compact?: boolean;
		disabled?: boolean;
		onFiles: (files: File[]) => void;
	}
	let { accept, maxSize, compact = false, disabled = false, onFiles }: Props = $props();

	let dragOver = $state(false);
	let inputEl: HTMLInputElement;

	function pick() {
		if (disabled) return;
		inputEl.click();
	}

	function onChange() {
		if (inputEl.files && inputEl.files.length > 0) onFiles([...inputEl.files]);
		inputEl.value = '';
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (disabled || !e.dataTransfer) return;
		const files = [...e.dataTransfer.files];
		if (files.length > 0) onFiles(files);
	}

	const label = $derived(m.storage_dropHere());
	const buttonLabel = $derived(m.storage_chooseFile());
</script>

<input bind:this={inputEl} type="file" multiple class="hidden" onchange={onChange} />

<div
	role="button"
	tabindex={disabled ? -1 : 0}
	aria-disabled={disabled}
	aria-label={`${buttonLabel}. Accepts ${accept}, up to ${maxSize}.`}
	onclick={pick}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			pick();
		}
	}}
	ondragover={(e) => {
		e.preventDefault();
		if (!disabled) dragOver = true;
	}}
	ondragleave={() => (dragOver = false)}
	ondrop={onDrop}
	class="flex flex-col items-center gap-2 rounded-[var(--ap-radius-2)] text-center transition-colors
		{compact ? 'p-3' : 'px-4 py-6'}
		{dragOver && !disabled
		? 'border border-[var(--ap-border-3)] bg-[var(--ap-ink)]/5'
		: 'border border-dashed border-[var(--ap-border-2)] bg-[var(--ap-paper-2)]'}
		{disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}"
>
	<RiFileUploadLine class="size-5 text-[var(--ap-ink-2)]" />
	<span class="font-sans text-[14px] text-[var(--ap-ink)]">{label}</span>
	<span
		class="rounded-[var(--ap-radius-1)] border border-[var(--ap-border-2)] bg-[var(--ap-stack-panel,var(--ap-paper))] px-3 py-1.5 font-mono text-[11px] tracking-wide text-[var(--ap-ink)] uppercase"
	>
		{buttonLabel}
	</span>
	{#if !compact}
		<span class="max-w-[280px] font-sans text-[12px] leading-[16px] text-[var(--ap-ink-3)]">
			{accept} · {m.storage_upTo({ size: maxSize })}
		</span>
	{/if}
</div>
