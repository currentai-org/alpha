<!--
  @component
  `Composer.Input` — the auto-growing textarea. Enter submits, Shift+Enter breaks a line, and
  composition (IME) input never submits mid-word.
-->
<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { getComposer } from './context.ts';

	let {
		placeholder = 'Ask anything',
		label = 'Message',
		ref = $bindable(),
		class: className,
		...rest
	}: Omit<HTMLTextareaAttributes, 'value'> & {
		label?: string;
		ref?: HTMLTextAreaElement | null;
	} = $props();

	const composer = getComposer();
	$effect(() => composer.registerInput(ref ?? null));

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			composer.submit();
		}
	}
</script>

<textarea
	bind:this={ref}
	value={composer.value}
	oninput={(e) => composer.setValue(e.currentTarget.value)}
	{onkeydown}
	{placeholder}
	aria-label={label}
	disabled={composer.disabled}
	rows="1"
	{...rest}
	class={cn(
		'field-sizing-content max-h-(--ds-composer-max-height) min-h-12 w-full resize-none bg-transparent px-2 py-1.5 type-body text-fg-1 outline-none',
		'placeholder:text-fg-3 focus-visible:outline-none',
		className
	)}></textarea>
