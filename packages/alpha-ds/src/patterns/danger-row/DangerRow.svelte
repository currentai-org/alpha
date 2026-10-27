<!--
  @component
  `DangerRow` — one irreversible action in a settings card: what it does on the left, a small
  destructive button on the right. Put it inside a `Surface`; the row brings its own padding, so
  every danger zone has the same frame and the same button size wherever it appears.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import Button from '../../components/button/Button.svelte';

	let {
		title,
		description,
		onclick,
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: Omit<HTMLButtonAttributes, 'type' | 'class' | 'children' | 'title'> & {
		/** Optional when a heading above the card already names the action. */
		title?: string;
		/** Body text when there is no title, a caption under it when there is. */
		description?: Snippet;
		onclick?: (event: MouseEvent) => void;
		/** The button, for anchoring the confirm that follows. */
		ref?: HTMLElement | null;
		class?: string;
		/** The button's contents: an icon and a label. */
		children?: Snippet;
	} = $props();
</script>

<div class={cn('flex items-center justify-between gap-3 px-3 py-3', className)} data-danger-row>
	<div class="min-w-0">
		{#if title}<div class="truncate type-body text-fg-1">{title}</div>{/if}
		{#if description}
			<div class={title ? 'type-caption text-fg-3' : 'type-body text-fg-2'}>
				{@render description()}
			</div>
		{/if}
	</div>
	<Button
		variant="destructive"
		size="sm"
		casing="sentence"
		class="flex-none"
		bind:ref
		{onclick}
		{...rest}
	>
		{@render children?.()}
	</Button>
</div>
