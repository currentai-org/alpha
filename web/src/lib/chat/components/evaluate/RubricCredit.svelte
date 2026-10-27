<script lang="ts">
	import type { Credit } from '$lib/chat/evaluate/types';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import { Favicon } from '@aipotluck/alpha-ds';
	import { faviconSrc } from '$lib/favicon';

	/** The credit to the rubric's source, with the links the API returns. Shown, not footnoted. */
	let { credit, compact = false }: { credit: Credit; compact?: boolean } = $props();
</script>

<aside
	class="flex flex-col gap-2 {compact ? '' : 'border border-line-2 p-3 rounded-card'}"
	aria-label="Where these questions come from"
	data-eval-credit
>
	<p class="type-caption text-fg-2">{credit.text}</p>
	<ul class="flex flex-wrap gap-x-4 gap-y-1">
		{#each credit.links as link (link.url)}
			<li>
				<a
					href={link.url}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1 type-caption text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
				>
					<Favicon src={faviconSrc(link.url)} class="mr-0.5" />{link.label}<RiArrowRightUpLine aria-hidden="true" class="size-3.5" />
				</a>
			</li>
		{/each}
	</ul>
</aside>
