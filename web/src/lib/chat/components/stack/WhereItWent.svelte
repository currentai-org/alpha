<script lang="ts">
	import { Badge } from '@aipotluck/alpha-ds';
	import type { Message } from '$lib/chat/types/Message';
	import { orgs } from '$lib/chat/routing/catalog';
	import { routeFor, type HopRole } from '$lib/chat/servingRoute';
	import OrgMention from '../provenance/OrgMention.svelte';

	/**
	 * "Where your last message went" (CUR-4580): one line per hop the answer's message passed through,
	 * read from what the turn recorded. A place nobody published, or a fact the turn did not record, says
	 * so in words; a hop outside Europe carries a tag.
	 */
	interface Props {
		answer: Message | undefined;
		/** The deployment's database region label (layoutData.ts), never the connection string. */
		storageRegion?: string | null;
	}
	let { answer, storageRegion }: Props = $props();

	const hops = $derived(routeFor(answer, storageRegion ?? undefined));
	const ROLE_LABEL: Record<HopRole, string> = {
		app: 'App server',
		router: 'Router',
		model: 'Model',
		storage: 'Stored in'
	};
</script>

<section class="mb-5" aria-labelledby="where-it-went" data-serving-route>
	<h3 id="where-it-went" class="type-label text-fg-2">Where your last message went</h3>
	<ul class="mt-2 flex flex-col gap-1.5">
		{#each hops as hop (hop.role)}
			<li
				class="flex flex-wrap items-baseline gap-x-2 gap-y-1 type-body text-fg-1"
				data-hop={hop.role}
				data-hop-source={hop.source ?? ''}
			>
				<span class="type-caption text-fg-2">{ROLE_LABEL[hop.role]}</span>
				{#if hop.orgId && orgs[hop.orgId]}
					<OrgMention org={orgs[hop.orgId]} />
				{:else if hop.name}
					<span>{hop.name}</span>
				{/if}
				<span class="text-fg-2" data-hop-place>{hop.place}</span>
				{#if hop.outsideEurope}
					<Badge tone="caution" data-hop-outside-europe>Outside Europe</Badge>
				{/if}
			</li>
		{/each}
	</ul>
</section>
