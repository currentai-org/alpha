<script lang="ts">
	import type { Org } from '$lib/chat/routing/catalog';
	import { cn } from '@aipotluck/alpha-ds';

	/**
	 * An organisation's square mark, shown beside its name wherever Alpha credits it. Logos are local
	 * files (static/logos), so crediting someone never pings a third party. Missing logo → monogram.
	 */
	let { org, size = 'sm', class: className }: { org: Org; size?: 'xs' | 'sm' | 'md'; class?: string } = $props();

	const box = $derived({ xs: 'size-4', sm: 'size-5', md: 'size-8' }[size]);
	const initials = $derived(
		org.name
			.split(/\s+/)
			.map((w) => w[0])
			.join('')
			.slice(0, 2)
			.toUpperCase()
	);
	let failed = $state(false);
</script>

{#if org.logo && !failed}
	<img
		src={org.logo}
		alt=""
		aria-hidden="true"
		decoding="async"
		onerror={() => (failed = true)}
		class={cn('inline-block shrink-0 border border-line-1 object-contain rounded-sharp', box, className)}
		data-org-logo={org.id}
	/>
{:else}
	<span
		aria-hidden="true"
		class={cn('inline-flex shrink-0 items-center justify-center border border-line-2 bg-surface-3 type-label text-fg-2 rounded-sharp', box, className)}
		data-org-logo={org.id}>{initials}</span
	>
{/if}
