<script lang="ts">
	import type { Org } from '$lib/chat/routing/catalog';
	import OrgLogo from './OrgLogo.svelte';

	/**
	 * How Alpha names a partner organisation in running text: its logo, then its name underlined as a
	 * link out to its site (opens a new tab). Without a URL on record the name is plain. Every partner
	 * named in the chat UI — model makers, hosts, storage, the Mozilla Data Collective — goes through
	 * this, so a credit always looks and behaves the same. Guidance: `design-system.md`.
	 */
	let {
		org,
		href = org.url,
		tabindex,
		class: className
	}: {
		org: Org;
		/** A deeper page on the partner's site; defaults to its home page. */
		href?: string;
		/** -1 inside a menu row, so opening the menu focuses the row, not this link. */
		tabindex?: number;
		class?: string;
	} = $props();
</script>

<span class="inline-flex items-baseline gap-1.5 whitespace-nowrap {className ?? ''}" data-org-mention={org.id}>
	<OrgLogo {org} size="xs" class="translate-y-0.5 self-center" />
	{#if href}
		<a {href} {tabindex} target="_blank" rel="noreferrer" class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
			>{org.name}</a
		>
	{:else}
		<span class="text-fg-1">{org.name}</span>
	{/if}
</span>
