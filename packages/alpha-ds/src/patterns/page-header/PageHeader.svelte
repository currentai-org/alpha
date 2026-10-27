<!--
  @component
  `PageHeader` — title block for non-conversation pages (settings, models, docs). Eyebrow in
  DM Mono, title, description, actions; a hard rule underneath. On a page nested inside another,
  `breadcrumbs` takes the eyebrow's place: the trail of parent pages, each a link back.
-->
<script lang="ts" module>
	export interface Crumb {
		label: string;
		/** Omit for a crumb that isn't a page of its own (a section label). */
		href?: string;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import { cn } from '../../internal/cn.ts';

	let {
		eyebrow,
		breadcrumbs,
		title,
		description,
		actions,
		class: className
	}: {
		eyebrow?: string;
		/** Parent pages, outermost first; the title is the current page. Replaces `eyebrow`. */
		breadcrumbs?: Crumb[];
		title: string;
		description?: string;
		actions?: Snippet;
		class?: string;
	} = $props();
</script>

<header
	class={cn(
		'flex flex-wrap items-end justify-between gap-4 border-b border-line-2 pb-6',
		className
	)}
>
	<div class="flex min-w-0 flex-col gap-2">
		{#if breadcrumbs?.length}
			<nav aria-label="Breadcrumb" data-breadcrumbs>
				<ol class="flex flex-wrap items-center gap-1 type-label text-fg-3">
					{#each breadcrumbs as crumb, i (i)}
						<li class="flex items-center gap-1">
							{#if crumb.href}
								<!-- eslint-disable svelte/no-navigation-without-resolve -- consumer passes a resolved href -->
								<a
									href={crumb.href}
									class="rounded-sharp transition-control hover:text-fg-1 focus-visible:text-fg-1"
									>{crumb.label}</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{:else}
								<span>{crumb.label}</span>
							{/if}
							<RiArrowRightSLine aria-hidden="true" class="size-3.5 shrink-0" />
						</li>
					{/each}
					<li aria-current="page" class="sr-only">{title}</li>
				</ol>
			</nav>
		{:else if eyebrow}<p class="type-label text-fg-3">{eyebrow}</p>{/if}
		<h1 class="type-heading text-fg-1">{title}</h1>
		{#if description}<p class="max-w-prose type-body text-fg-2">{description}</p>{/if}
	</div>
	{#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</header>
