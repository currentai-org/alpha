<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getContext } from 'svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { RETENTION_DAYS } from '$lib/chat/constants/retention';
	import DataHomeLead from '$lib/chat/components/provenance/DataHomeLead.svelte';
	import { BENTO_SIGNED_IN } from './context';
	import { BentoTile } from '@aipotluck/alpha-ds';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiChat3Line from '~icons/ri/chat-3-line';
	import RiArrowGoBackLine from '~icons/ri/arrow-go-back-line';

	/**
	 * Your data: where it is kept, for how long, and one button that really forgets. Here it forgets the
	 * sample chats (and can put them back); in the app it's Settings → Data & privacy.
	 */
	// A signed-in account's conversations carry no expiry, so it is not told the guest clock (CUR-1731).
	const signedInGetter = getContext<(() => boolean) | undefined>(BENTO_SIGNED_IN);
	const signedIn = $derived(signedInGetter?.() ?? false);
	// The English title follows the interface language; the others are already written in theirs.
	const sample = $derived([
		m.welcome_sampleChatAiAct(),
		'Tóm tắt ý kiến cư dân',
		'Bürgerbrief in Leichter Sprache',
		'Rapport annuel de l’association'
	]);
	const ALL = [0, 1, 2, 3];
	let chats = $state([...ALL]);
	const forgotten = $derived(chats.length === 0);
</script>

<BentoTile
	icon={RiShieldCheckLine}
	title={m.welcome_dataTitle()}
	body={signedIn
		? m.welcome_dataBodySignedIn()
		: m.welcome_dataBodyGuest({ days: RETENTION_DAYS })}
>
	<div
		class="w-full max-w-sm rounded-card bg-surface-raised p-4 shadow-popover"
	>
		<DataHomeLead />
		<ul class="mt-4 flex min-h-36 flex-col gap-1.5" aria-label={m.welcome_yourConversations()}>
			{#each chats as c (c)}
				<li
					animate:flip={{ duration: 200 }}
					out:fly={{ x: -24, duration: 180 }}
					class="flex items-center gap-2 rounded-sharp border border-line-surface bg-surface-1 px-3 py-2 type-caption text-fg-1"
				>
					<RiChat3Line aria-hidden="true" class="size-3.5 text-fg-3" />
					<span class="flex-1 truncate">{sample[c]}</span>
				</li>
			{/each}
			{#if forgotten}
				<li
					in:fly={{ y: 6, duration: 200, delay: 180 }}
					class="grid flex-1 place-items-center py-6 text-center type-caption text-fg-2"
				>
					{m.welcome_everythingGone()}
				</li>
			{/if}
		</ul>
		{#if !signedIn}
		<div class="mt-4 flex items-center gap-2 type-caption text-fg-3">
			<span>{m.product_today()}</span>
			<span class="relative h-1.5 flex-1 rounded-pill bg-tint-hover">
				<span class="absolute inset-y-0 left-0 w-1/3 rounded-pill bg-accent-1"></span>
			</span>
			<span>{m.welcome_days({ days: RETENTION_DAYS })}</span>
		</div>
		{/if}
		<div class="mt-4 flex justify-end">
			{#if forgotten}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-sharp border border-line-2 bg-surface-2 px-2.5 py-1 type-caption text-fg-1 hover:bg-surface-3"
					onclick={() => (chats = [...ALL])}
				>
					<RiArrowGoBackLine aria-hidden="true" class="size-3.5" /> {m.welcome_bringSamplesBack()}
				</button>
			{:else}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-sharp border border-line-2 bg-surface-2 px-2.5 py-1 type-caption text-fg-1 hover:bg-surface-3"
					onclick={() => (chats = [])}
				>
					<RiDeleteBinFill aria-hidden="true" class="size-3.5 text-accent-2" /> {m.welcome_forgetEverything()}
				</button>
			{/if}
		</div>
	</div>
</BentoTile>
