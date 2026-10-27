<script lang="ts">
	import { orgs } from '$lib/chat/routing/catalog';
	import { m } from '$lib/paraglide/messages.js';
	import OrgMention from './OrgMention.svelte';

	/**
	 * The credit for Clef under Auto's explanation in the model picker: the open-weight classifier
	 * Auto asks to read a draft, its maker (Cloudflare) and where its weights are published (Hugging
	 * Face, linking to the model card of the size that read it). Shown only with `clef-routing` on.
	 */
	let {
		classifier,
		tabindex
	}: {
		/** The size that read the draft (`clef` or `clef-flash`); the full model before any read. */
		classifier?: string;
		/** -1 inside a menu, so opening the menu focuses its rows, not these links. */
		tabindex?: number;
	} = $props();

	const flash = $derived(classifier === 'clef-flash');
	const card = $derived(`https://huggingface.co/Cloudflare/${flash ? 'clef-flash' : 'clef'}`);
	const parts = $derived(
		m.product_clefCredit({ model: '{model}', maker: '{maker}', host: '{host}' })
			.split(/(\{model\}|\{maker\}|\{host\})/)
			.filter(Boolean)
	);
</script>

<p class="type-caption text-fg-2" data-clef-credit>
	{#each parts as part, i (i)}{#if part === '{model}'}<span class="text-fg-1">{flash ? 'Clef Flash' : 'Clef'}</span
			>{:else if part === '{maker}'}<OrgMention org={orgs.cloudflare} {tabindex} />{:else if part === '{host}'}<OrgMention
				org={orgs.huggingface}
				href={card}
				{tabindex}
			/>{:else}{part}{/if}{/each}
</p>
