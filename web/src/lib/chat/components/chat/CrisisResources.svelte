<script lang="ts">
	import { page } from '$app/state';
	import CarbonFavorite from '~icons/carbon/favorite';
	import { crisisLocale } from '$lib/chat/crisisLocale';
	import { cardText, pickCardCopy, type CrisisCardKey } from '$lib/chat/crisisCardCopy';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, locales } from '$lib/paraglide/runtime.js';

	// Compassionate, additive crisis-resource card — shown when the user's message trips an
	// unambiguous self-harm/suicidal-ideation signal (src/lib/crisis.ts, client-side, stores nothing).
	// It NEVER replaces or blocks the model's answer; it sits at the top of the reply so real help is
	// the first thing a person in distress sees.
	//
	// When the request carried the visitor's country and findahelpline.com has a page for it,
	// the card leads with that page and the country's emergency number (crisisLocale.ts). We hold no
	// helpline numbers ourselves: findahelpline keeps them current. Otherwise the card is the generic
	// list, which leads with Europe (112), then the country-finder, with US-988 last as a regional
	// example: the audience is mostly European.
	//
	// Tone: calm and plain, not alarm. Deliberately NOT gap-red (reads as error) and NOT the coral CTA
	// colour (reserved for "contribute"); a quiet supportive card. Honest about being an automated
	// pointer to real people, not a diagnosis.
	// (CUR-3912)
	// The copy is in the language the person wrote in, `lang` (a BCP-47 primary subtag from the
	// support classifier), when the catalogs carry it; a language they don't (Hausa, Swahili until a
	// native review) gets English, never the UI's language. With no `lang`, the UI's language. (CUR-4094)
	// Catalan, Italian and Portuguese come from a card-only table (crisisCardCopy.ts), since
	// the UI catalogs do not carry them. (CUR-4103)
	// `country` is the country the person's message places the person at risk in, as the
	// support classifier read it. It wins over the visitor's IP country, which can be wrong (a Hong Kong
	// connection read as Taiwan) or simply not where the person at risk is (a teacher abroad). (CUR-4488)
	let { lang, country: namedCountry }: { lang?: string; country?: string } = $props();
	type Locale = (typeof locales)[number];
	const copy = $derived(pickCardCopy(lang, locales, getLocale()));
	const cardLocale = $derived(copy.kind === 'card' ? copy.lang : copy.locale);
	// Named one by one: indexing `m` by a variable key keeps every message in the bundle (~64 KB).
	type Message = (p: Record<string, string>, o: { locale: Locale }) => string;
	const catalog: Record<CrisisCardKey, Message> = {
		chat_crisis_label: m.chat_crisis_label,
		chat_crisis_intro: m.chat_crisis_intro,
		chat_crisis_helplinesIn: (p, o) => m.chat_crisis_helplinesIn({ country: p.country }, o),
		chat_crisis_helplinesNote: m.chat_crisis_helplinesNote,
		chat_crisis_dangerNumber: (p, o) => m.chat_crisis_dangerNumber({ number: p.number }, o),
		chat_crisis_dangerLocal: m.chat_crisis_dangerLocal,
		chat_crisis_dangerGeneric: m.chat_crisis_dangerGeneric,
		chat_crisis_automatic: m.chat_crisis_automatic,
		chat_crisis_europe: m.chat_crisis_europe,
		chat_crisis_europeNote: m.chat_crisis_europeNote,
		chat_crisis_findNote: m.chat_crisis_findNote,
		chat_crisis_usNote: m.chat_crisis_usNote
	};
	const text = (key: CrisisCardKey, params: Record<string, string> = {}) =>
		copy.kind === 'card'
			? cardText(copy.lang, key, params)
			: catalog[key](params, { locale: copy.locale as Locale });
	const locale = $derived(crisisLocale(namedCountry) ?? crisisLocale(page.data.visitorCountry));
	const country = $derived.by(() => {
		if (!locale) return '';
		try {
			return new Intl.DisplayNames([cardLocale], { type: 'region' }).of(locale.code.toUpperCase()) ?? locale.name;
		} catch {
			return locale.name;
		}
	});
</script>

<div
	class="mb-3 rounded-card border border-line-2 bg-surface-2 px-4 py-3 text-fg-2"
	role="note"
	aria-label={text('chat_crisis_label')}
	lang={cardLocale}
	data-crisis-country={locale?.code ?? ''}
>
	<div class="flex items-start gap-2.5">
		<CarbonFavorite class="mt-0.5 size-4 shrink-0 text-fg-2" aria-hidden="true" />
		<div class="min-w-0 text-body leading-relaxed">
			<p class="text-fg-1">
				{text('chat_crisis_intro')}
			</p>
			{#if locale}
				<ul class="mt-1.5 space-y-1">
					<li>
						<a
							class="font-medium text-fg-1 underline underline-offset-2"
							href={locale.helplineUrl}
							target="_blank"
							rel="noreferrer">{text('chat_crisis_helplinesIn', { country })}</a
						>
						<span class="text-fg-2">{text('chat_crisis_helplinesNote')}</span>
					</li>
				</ul>
				<p class="mt-1.5 text-small text-fg-2">
					{locale.emergency
						? text('chat_crisis_dangerNumber', { number: locale.emergency })
						: text('chat_crisis_dangerLocal')}
					{text('chat_crisis_automatic')}
				</p>
			{:else}
				<!-- Europe first, then the country-finder, with 988 as a regional (US) example last. -->
				<ul class="mt-1.5 space-y-1">
					<li>
						<span class="font-medium text-fg-1">{text('chat_crisis_europe')}</span>
						<span class="text-fg-2">{text('chat_crisis_europeNote')}</span>
					</li>
					<li>
						<a
							class="font-medium text-fg-1 underline underline-offset-2"
							href="https://findahelpline.com"
							target="_blank"
							rel="noreferrer">findahelpline.com</a
						>
						<span class="text-fg-2">{text('chat_crisis_findNote')}</span>
					</li>
					<li>
						<a
							class="font-medium text-fg-1 underline underline-offset-2"
							href="https://988lifeline.org"
							target="_blank"
							rel="noreferrer">988 Lifeline</a
						>
						<span class="text-fg-2">{text('chat_crisis_usNote')}</span>
					</li>
				</ul>
				<p class="mt-1.5 text-small text-fg-2">
					{text('chat_crisis_dangerGeneric')}
					{text('chat_crisis_automatic')}
				</p>
			{/if}
		</div>
	</div>
</div>
