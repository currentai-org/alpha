<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$lib/chat/paths';
	import { Button } from '@aipotluck/alpha-ds';
	import { detectLanguage } from '$lib/chat/routing/heuristic';
	import { languageName } from '$lib/chat/routing/languages';
	import { DEFAULT_ROUTING } from '$lib/chat/routing/router';
	import LanguageDataActions from './LanguageDataActions.svelte';
	import RiSeedlingLine from '~icons/ri/seedling-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';

	/**
	 * Shown under an answer after someone reports "It didn't work in my language", at most once per
	 * conversation: why a model can be weaker in a language, and the data call-to-action for it. The
	 * language is read from the request the answer replied to (the answer may not be in it), on the
	 * device; without a confident read it points to the Contribute page instead.
	 */
	let { conversationId, text }: { conversationId: string; text: string } = $props();

	const detected = $derived(detectLanguage(text));
	const tag = $derived(
		detected.value !== 'und' && detected.value !== 'eng' && detected.confidence >= DEFAULT_ROUTING.gapConfidence
			? detected.value
			: undefined
	);

	// Once per conversation: the first language report in it shows the note; later ones don't.
	let show = $state(false);
	onMount(() => {
		const key = `alpha:language-data-note:${conversationId}`;
		try {
			if (sessionStorage.getItem(key)) return;
			sessionStorage.setItem(key, '1');
		} catch {
			/* storage unavailable: show it this once */
		}
		show = true;
	});
</script>

{#if show}
	<section
		class="flex gap-3 border border-line-2 bg-surface-raised p-3 rounded-card"
		aria-label="Help with data for your language"
		data-language-report-note={tag ?? 'unknown'}
	>
		<RiSeedlingLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-accent-1-text" />
		<div class="flex min-w-0 flex-col gap-2">
			<p class="type-caption text-fg-2">
				Thanks for telling us. Models are weaker in some languages for several reasons: how they were trained, how
				they were tested, and how much text in the language they had to learn from. Data is one of those reasons, and
				it’s one you can help with{tag ? ` for ${languageName(tag)}` : ''}.
			</p>
			{#if tag}
				<LanguageDataActions language={tag} name={languageName(tag)} surface="answer_language_report" />
			{:else}
				<Button href={`${base}/settings/contribute`} variant="ghost" size="sm" casing="sentence" class="self-start">
					Help with data for your language <RiArrowRightLine aria-hidden="true" />
				</Button>
			{/if}
		</div>
	</section>
{/if}
