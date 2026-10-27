<!--
  @component
  Catalog code block: server-highlighted HTML (or plain text), copy button, optional collapse.
-->
<script lang="ts">
	import RiCheckLine from '~icons/ri/check-line';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import { Button, cn } from '@aipotluck/alpha-ds';
	import './code.css';

	let {
		code,
		html,
		label,
		collapsible = false,
		class: className
	}: {
		code: string;
		/** Pre-highlighted HTML from highlight.server.ts. */
		html?: string;
		label?: string;
		/** Clamp tall blocks with a "Show all" toggle. */
		collapsible?: boolean;
		class?: string;
	} = $props();

	let copied = $state(false);
	let expanded = $state(false);
	const lines = $derived(code.trimEnd().split('\n').length);
	const clamp = $derived(collapsible && lines > 14 && !expanded);

	async function copy() {
		await navigator.clipboard.writeText(code.trimEnd());
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class={cn('ds-code relative border border-line-2 bg-surface-2', className)} data-surface="2">
	<div class="flex h-control-md items-center justify-between border-b border-line-1 pr-1 pl-3">
		<span class="type-label text-fg-3">{label ?? 'Svelte'}</span>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={copied ? 'Copied' : 'Copy code'}
			onclick={copy}
		>
			{#if copied}<RiCheckLine />{:else}<RiFileCopyLine />{/if}
		</Button>
	</div>
	<div class={cn('relative', clamp && 'max-h-72 overflow-hidden')}>
		{#if html}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- Shiki output of repo source files -->
			{@html html}
		{:else}
			<pre><code>{code.trimEnd()}</code></pre>
		{/if}
		{#if clamp}
			<div
				class="absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-linear-to-t from-surface-2 to-transparent pb-3"
			>
				<Button size="sm" onclick={() => (expanded = true)}>Show all {lines} lines</Button>
			</div>
		{/if}
	</div>
</div>
