<!--
  @component
  Base UI `Toast.Root` — one toast. Background 3 with a type-coloured left rule (the spec's
  accent-as-line usage), Title/Description/Action/Close composed inside.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import RiCheckboxCircleFill from '~icons/ri/checkbox-circle-fill';
	import RiErrorWarningFill from '~icons/ri/error-warning-fill';
	import RiLoader4Line from '~icons/ri/loader-4-line';
	import { cn } from '../../internal/cn.ts';
	import Close from './Close.svelte';
	import { useToastManager, type ToastItem } from './manager.svelte.ts';

	let {
		toast,
		class: className,
		children
	}: { toast: ToastItem; class?: string; children?: Snippet } = $props();
	const manager = useToastManager();
</script>

<div
	role={toast.type === 'error' ? 'alert' : 'status'}
	data-type={toast.type}
	data-testid={toast.testId}
	data-surface="3"
	class={cn(
		'pointer-events-auto relative flex motion-popup items-start gap-3 rounded-popup border border-l-4 border-line-2 bg-surface-3 py-3 pr-10 pl-3 text-fg-1 shadow-popover',
		toast.type === 'error' && 'border-l-accent-2',
		toast.type === 'success' && 'border-l-positive',
		toast.type === 'default' && 'border-l-line-strong',
		toast.type === 'loading' && 'border-l-line-3',
		className
	)}
	data-state="open"
>
	{#if toast.type === 'success'}<RiCheckboxCircleFill
			class="mt-0.5 size-4 shrink-0 text-positive"
			aria-hidden="true"
		/>{/if}
	{#if toast.type === 'error'}<RiErrorWarningFill
			class="mt-0.5 size-4 shrink-0 text-accent-2"
			aria-hidden="true"
		/>{/if}
	{#if toast.type === 'loading'}<RiLoader4Line
			class="mt-0.5 size-4 shrink-0 animate-spin text-fg-2"
			aria-hidden="true"
		/>{/if}
	<div class="flex min-w-0 flex-1 flex-col gap-0.5">
		{#if children}
			{@render children()}
		{:else}
			{#if toast.title}<p class="type-body font-medium text-fg-1" data-toast-title>
					{toast.title}
				</p>{/if}
			{#if toast.description}<p class="type-caption text-fg-2">{toast.description}</p>{/if}
			{#if toast.action}
				<button
					type="button"
					class="mt-1 self-start type-cta text-fg-1 underline decoration-line-3 underline-offset-4 hover:decoration-fg-1"
					onclick={() => {
						toast.action?.onClick();
						manager.close(toast.id);
					}}>{toast.action.label}</button
				>
			{/if}
		{/if}
	</div>
	<Close onclick={() => manager.dismiss(toast.id)} />
</div>
