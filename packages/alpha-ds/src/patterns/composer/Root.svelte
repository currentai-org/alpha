<!--
  @component
  `Composer.Root` — the message box (the composer). Radius 2 (the spec's one rounded
  input), Background 2 (recessed), Border 2 rising to Border 3 while focused, and the spec's
  hover-only soft shadow. Owns the draft and submit/stop wiring for its parts.

  ```svelte
  <Composer.Root bind:value onsubmit={send} busy={streaming} onstop={stop}>
    <Composer.Input placeholder="Ask anything" />
    <Composer.Toolbar>
      <Composer.Tools>…</Composer.Tools>
      <Composer.Send />
    </Composer.Toolbar>
  </Composer.Root>
  ```
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { setComposer } from './context.ts';

	let {
		value = $bindable(''),
		disabled = false,
		busy = false,
		onsubmit,
		onstop,
		class: className,
		children,
		above
	}: {
		value?: string;
		disabled?: boolean;
		/** A reply is streaming: Send becomes Stop. */
		busy?: boolean;
		onsubmit?: (value: string) => void;
		onstop?: () => void;
		class?: string;
		children?: Snippet;
		/** Slot above the box (attachments, notices). */
		above?: Snippet;
	} = $props();

	let input: HTMLTextAreaElement | null = null;
	const canSubmit = $derived(!disabled && !busy && value.trim().length > 0);

	function submit() {
		if (!canSubmit) return;
		onsubmit?.(value);
	}

	setComposer({
		get value() {
			return value;
		},
		get disabled() {
			return disabled;
		},
		get busy() {
			return busy;
		},
		get canSubmit() {
			return canSubmit;
		},
		setValue(v) {
			value = v;
		},
		submit,
		stop() {
			onstop?.();
		},
		registerInput(el) {
			input = el;
		},
		focus() {
			input?.focus();
		}
	});
</script>

<form
	class={cn('flex w-full flex-col gap-2', className)}
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	{@render above?.()}
	<div
		data-surface="2"
		data-disabled={disabled ? '' : undefined}
		class={cn(
			'flex flex-col gap-1 rounded-field border border-line-2 bg-surface-2 p-2 transition-control',
			'focus-within:border-line-3 hover:shadow-[0_2px_12px_-4px_var(--ds-overlay)]',
			'data-disabled:opacity-60'
		)}
	>
		{@render children?.()}
	</div>
</form>
