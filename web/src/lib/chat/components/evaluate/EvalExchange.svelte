<script lang="ts">
	import type { Direction } from '$lib/chat/evaluate/types';
	import RiUser3Line from '~icons/ri/user-3-line';
	import RiSpyLine from '~icons/ri/spy-line';

	/**
	 * The request and the answer being rated, laid out as the short conversation they were: who
	 * asked, then a model whose name stays hidden. Only these two take the language's direction, so
	 * Arabic, Urdu and Pashto read right to left inside the English interface. No English version is
	 * shown. Stays in view beside the questions (the page pins it), scrolling on its own when long.
	 */
	let { prompt, answer, dir, lang }: { prompt: string; answer: string; dir: Direction; lang?: string } = $props();
</script>

<div
	class="flex flex-col gap-4 border border-line-2 bg-surface-2 p-4 rounded-card lg:max-h-160 lg:overflow-y-auto lg:scroll-fade-y"
	data-eval-exchange
>
	<section class="flex flex-col gap-2" aria-labelledby="eval-request-label">
		<h3 id="eval-request-label" class="flex items-center gap-2 type-label text-fg-3">
			<span class="grid size-6 place-items-center border border-line-2 bg-surface-raised rounded-pill">
				<RiUser3Line aria-hidden="true" class="size-3.5" />
			</span>
			Someone asked
		</h3>
		<p {dir} {lang} class="type-body whitespace-pre-line text-fg-1" data-eval-prompt>{prompt}</p>
	</section>
	<section class="flex flex-col gap-2 border-t border-line-2 pt-4" aria-labelledby="eval-answer-label">
		<h3 id="eval-answer-label" class="flex items-center gap-2 type-label text-fg-3">
			<span class="grid size-6 place-items-center border border-line-2 bg-surface-raised rounded-pill">
				<RiSpyLine aria-hidden="true" class="size-3.5" />
			</span>
			A model answered <span class="text-fg-3 normal-case">· name hidden</span>
		</h3>
		<p {dir} {lang} class="type-body whitespace-pre-line text-fg-1" data-eval-answer>{answer}</p>
	</section>
</div>
