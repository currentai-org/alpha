<!--
  @component
  Kbd — a keyboard key. Alpha addition. Renders `⌘`/`Ctrl` correctly per platform when given
  `mod`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { browser } from '$app/environment';
	import { cn } from '../../internal/cn.ts';

	let {
		mod = false,
		class: className,
		children
	}: { mod?: boolean; class?: string; children?: Snippet } = $props();
	const isMac = browser && /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<kbd
	class={cn(
		'inline-flex h-5 min-w-5 items-center justify-center rounded-sharp border border-line-surface bg-surface-raised px-1 font-mono text-micro text-fg-2',
		className
	)}
>
	{#if mod}{isMac ? '⌘' : 'Ctrl'}{/if}{@render children?.()}
</kbd>
