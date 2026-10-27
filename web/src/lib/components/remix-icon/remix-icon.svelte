<script lang="ts">
	import { cn } from '$lib/utils.js';

	type Props = {
		svg: string;
		class?: string;
	};

	let { svg, class: className = '' }: Props = $props();
</script>

<!-- SVG strings come from Payload's icon picker (Remix Icon logos); trusted CMS content. -->
<!-- eslint-disable svelte/no-at-html-tags -- CMS-provided SVG from payload-icon-picker -->
<span class={cn('inline-flex shrink-0 [&>svg]:size-5', className)} aria-hidden="true">
	{@html svg}
</span>
<!-- eslint-enable svelte/no-at-html-tags -->
