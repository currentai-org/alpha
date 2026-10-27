<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { Badge, BentoTile } from '@aipotluck/alpha-ds';
	import { catalog, orgs } from '$lib/chat/routing/catalog';
	import { heuristicClassify } from '$lib/chat/routing/heuristic';
	import { route } from '$lib/chat/routing/router';
	import OrgLogo from '$lib/chat/components/provenance/OrgLogo.svelte';
	import RiTranslate2 from '~icons/ri/translate-2';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';

	/**
	 * Language: pick a sample (or type your own) and watch Alpha's real Auto router — the same
	 * heuristic and catalog the app uses — choose the open model built for it.
	 */
	const samples = [
		{ label: 'Català', text: 'Què és el millor per aprendre amb els nens?' },
		{ label: 'Bahasa', text: 'Bagaimana cara membuat rendang untuk pemula?' },
		{ label: 'Polski', text: 'Czy możesz napisać wiersz o Krakowie?' },
		{ label: 'Tagalog', text: 'Paano ako makakatipid ng pera ngayong buwan?' },
		{ label: 'Deutsch', text: 'Wie kann ich zu Hause Energie sparen?' },
		{ label: 'English', text: 'What is the best way to learn a new language?' }
	];
	const live = catalog.filter((entry) => entry.status === 'live').map((entry) => entry.gatewayId!);

	let text = $state(samples[0].text);
	const choice = $derived(text.trim().length > 2 ? route(heuristicClassify(text), live) : undefined);
	const maker = $derived(choice ? orgs[choice.model.maker] : undefined);
</script>

<BentoTile
	icon={RiTranslate2}
	title={m.welcome_languageTitle()}
	body={m.welcome_languageBody()}
>
	<div class="flex w-full max-w-md flex-col gap-3">
		<div class="flex flex-wrap gap-1.5" role="group" aria-label={m.welcome_sampleLanguages()}>
			{#each samples as s (s.label)}
				<button
					type="button"
					class="rounded-pill border px-2.5 py-1 type-caption transition-control {text ===
					s.text
						? 'border-accent-1 bg-surface-raised text-fg-1'
						: 'border-line-2 bg-surface-1 text-fg-2 hover:border-line-3 hover:text-fg-1'}"
					aria-pressed={text === s.text}
					onclick={() => (text = s.text)}>{s.label}</button
				>
			{/each}
		</div>
		<label
			class="flex flex-col gap-2 rounded-field bg-surface-1 p-3 shadow-popover"
		>
			<span class="sr-only">{m.welcome_yourMessage()}</span>
			<textarea
				bind:value={text}
				rows="2"
				class="w-full resize-none bg-transparent type-body text-fg-1 outline-none placeholder:text-fg-3"
				placeholder={m.welcome_languagePlaceholder()}></textarea>
			<span
				class="inline-flex w-fit max-w-full items-center gap-1.5 rounded-pill border border-line-2 bg-surface-raised px-2 py-0.5 type-caption text-fg-1"
			>
				<RiSparkling2Line aria-hidden="true" class="size-3.5 text-accent-1-text" /> {m.product_auto()}{choice
					?.reasons[0]
					? ` · ${choice.reasons[0]}`
					: ''}
			</span>
		</label>
		<div class="min-h-32" aria-live="polite">
			{#if choice && maker}
				<div class="flex flex-col gap-2 rounded-card border border-line-2 bg-surface-raised p-3">
					<div class="flex flex-wrap items-center gap-2.5">
						<OrgLogo org={maker} size="md" />
						<span class="flex min-w-0 flex-1 basis-40 flex-col">
							<span class="type-body text-fg-1">{choice.model.name}</span>
							<span class="type-caption text-fg-3">
								{m.welcome_byMaker({ maker: maker.name })}
							</span>
						</span>
						<span class="flex flex-wrap gap-1.5">
							{#each choice.reasons as r (r)}<Badge>{r}</Badge>{/each}
						</span>
					</div>
					<p class="type-caption text-fg-2">{choice.model.strength}</p>
				</div>
			{:else}
				<p class="p-3 type-caption text-fg-3">{m.welcome_typeAFewWords()}</p>
			{/if}
		</div>
	</div>
</BentoTile>
