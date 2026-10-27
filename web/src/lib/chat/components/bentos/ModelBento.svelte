<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { orgs } from '$lib/chat/routing/catalog';
	import { wwwPickerCatalog } from '$lib/chat/routing/wwwPicker';
	import OrgLogo from '$lib/chat/components/provenance/OrgLogo.svelte';
	import { BentoTile } from '@aipotluck/alpha-ds';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	import RiCpuLine from '~icons/ri/cpu-line';
	import RiCheckLine from '~icons/ri/check-line';

	/**
	 * Model choice: leave it on Auto, or pin one of the open models Alpha runs. The list is www's picker
	 * (CUR-4099), with maker and host from the same associations X-ray shows.
	 */
	const live = wwwPickerCatalog;
	let picked = $state<string>('auto');
</script>

<BentoTile
	icon={RiCpuLine}
	title={m.welcome_modelTitle()}
	body={m.welcome_modelBody()}
>
	<div
		class="w-full max-w-sm rounded-card bg-surface-raised p-1.5 shadow-popover"
		role="radiogroup"
		aria-label={m.welcome_model()}
	>
		{#snippet row(checked: boolean)}
			{#if checked}<RiCheckLine aria-hidden="true" class="size-4 text-accent-1-text" />{:else}<span
					class="size-4"
				></span>{/if}
		{/snippet}
		<button
			type="button"
			role="radio"
			aria-checked={picked === 'auto'}
			class="flex w-full items-center gap-2.5 rounded-sharp px-2.5 py-2 text-left hover:bg-tint-hover"
			onclick={() => (picked = 'auto')}
		>
			<span class="grid size-6 place-items-center rounded-sharp border border-line-2 bg-surface-1"
				><RiSparkling2Line aria-hidden="true" class="size-3.5 text-accent-1-text" /></span
			>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="type-caption text-fg-1">{m.product_auto()}</span>
				<span class="truncate type-caption text-fg-3">{m.welcome_autoHint()}</span>
			</span>
			{@render row(picked === 'auto')}
		</button>
		<div class="my-1 h-px bg-line-1"></div>
		{#each live as entry (entry.id)}
			<button
				type="button"
				role="radio"
				aria-checked={picked === entry.id}
				class="flex w-full items-center gap-2.5 rounded-sharp px-2.5 py-1.5 text-left hover:bg-tint-hover"
				onclick={() => (picked = entry.id)}
			>
				<OrgLogo org={orgs[entry.maker]} size="sm" />
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="type-caption text-fg-1">{entry.name}</span>
					<span class="truncate type-caption text-fg-3">
						{orgs[entry.maker].name}
					</span>
				</span>
				{@render row(picked === entry.id)}
			</button>
		{/each}
	</div>
</BentoTile>
