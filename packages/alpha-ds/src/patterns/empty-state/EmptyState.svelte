<!--
  @component
  `EmptyState` — the new-conversation landing (greeting, then the composer
  centred, then suggestions). Heading follows the spec's empty-state type (Font 2, Size 5,
  tight); the description reads at Text 3 AA.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		title,
		description,
		mark,
		class: className,
		children,
		suggestions
	}: {
		title: string;
		description?: string;
		/** Brand mark above the title (the Potluck diamond by default). */
		mark?: Snippet;
		class?: string;
		/** Usually a `Composer`. */
		children?: Snippet;
		/** Prompt suggestions under the composer. */
		suggestions?: Snippet;
	} = $props();
</script>

<section
	class={cn('mx-auto flex w-full max-w-thread flex-col items-stretch gap-6 px-4', className)}
>
	<div class="flex flex-col items-start gap-3">
		{#if mark}{@render mark()}{:else}<span
				class="block size-3 rotate-45 bg-accent-1"
				aria-hidden="true"
			></span>{/if}
		<h2 class="type-heading text-fg-1">{title}</h2>
		{#if description}<p class="max-w-prose type-caption text-fg-3">{description}</p>{/if}
	</div>
	{@render children?.()}
	{#if suggestions}<div class="flex flex-wrap gap-2">{@render suggestions()}</div>{/if}
</section>
