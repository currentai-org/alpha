<script lang="ts">
	import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
	import type { Component } from 'svelte';
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import DataBento from '$lib/chat/components/bentos/DataBento.svelte';
	import FootprintBento from '$lib/chat/components/bentos/FootprintBento.svelte';
	import InstructionsBento from '$lib/chat/components/bentos/InstructionsBento.svelte';
	import LanguageBento from '$lib/chat/components/bentos/LanguageBento.svelte';
	import ModelBento from '$lib/chat/components/bentos/ModelBento.svelte';
	import ThemeBento from '$lib/chat/components/bentos/ThemeBento.svelte';
	import XRayBento from '$lib/chat/components/bentos/XRayBento.svelte';
	import { getAlphaLandingContent } from '../../content.svelte';
	import type { FeatureId } from '../../copy';
	const readContent = getAlphaLandingContent();
	const features = $derived(
		readContent().features.map(({ key, ...feature }) => ({ ...feature, id: key }))
	);
	const sectionsIntro = $derived(readContent().sectionsIntro);
	import PatternGlyph from './PatternGlyph.svelte';
	import { spotlight } from './spotlight';

	type Tone = 'sky' | 'coral' | 'pink';

	// Each chapter carries one tone, one pattern kind (its marker and the field behind its bentos)
	// and the idea its index card acts out in the pattern. X-ray is the dark chapter.
	const chapters: Record<
		FeatureId,
		{
			tone: Tone;
			kind: 'dots' | 'tiles' | 'inverse';
			glyph: 'language' | 'data' | 'rules' | 'xray';
			dark?: boolean;
			bentos: Component[];
		}
	> = {
		language: { tone: 'sky', kind: 'dots', glyph: 'language', bentos: [LanguageBento] },
		data: { tone: 'coral', kind: 'tiles', glyph: 'data', bentos: [DataBento, FootprintBento] },
		rules: {
			tone: 'pink',
			kind: 'dots',
			glyph: 'rules',
			bentos: [ThemeBento, InstructionsBento, ModelBento]
		},
		router: { tone: 'sky', kind: 'inverse', glyph: 'xray', dark: true, bentos: [XRayBento] }
	};
</script>

<section
	class="mx-auto w-full max-w-8xl px-(--panel-padding) pb-24 md:pb-32"
	aria-labelledby="bold-intro-title"
>
	<div class="reveal grid items-end gap-x-16 gap-y-6 lg:grid-cols-12">
		<div class="lg:col-span-7">
			<p
				class="flex items-center gap-3 font-mono text-[12px] tracking-[0.16em] text-dark-blue/60 uppercase"
			>
				<span class="pat pat-dots tone-pink size-3.5" style:--pat-cell="7px" aria-hidden="true"
				></span>
				{sectionsIntro.eyebrow}
			</p>
			<h2
				id="bold-intro-title"
				class="mt-5 font-noto-serif text-[clamp(2.5rem,5.4vw,3.75rem)] leading-[0.96] font-semibold tracking-[-0.035em] text-balance"
			>
				{sectionsIntro.title}
			</h2>
		</div>
		<p
			class="max-w-md font-jakarta text-[clamp(1.0625rem,1.3vw,1.1875rem)] leading-relaxed text-dark-blue/80 lg:col-span-5"
		>
			{sectionsIntro.body}
		</p>
	</div>

	<ol class="mt-12 grid gap-3 sm:grid-cols-2 md:mt-16 lg:grid-cols-4">
		{#each features as feature (feature.id)}
			{@const chapter = chapters[feature.id]}
			<li class="reveal">
				<a
					href="#{feature.id}"
					class="index-card group flex h-full flex-col bg-pale-grey transition-transform duration-300 hover:-translate-y-1"
				>
					<div class="relative aspect-[4/3] overflow-hidden">
						<PatternGlyph concept={chapter.glyph} />
					</div>
					<div class="flex flex-1 items-end justify-between gap-4 p-5">
						<span
							class="font-noto-serif text-[1.625rem] leading-[1.05] font-semibold tracking-[-0.03em]"
							>{feature.eyebrow}</span
						>
						<ArrowDownRightIcon
							class="size-6 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:translate-y-0.5"
							aria-hidden="true"
						/>
					</div>
				</a>
			</li>
		{/each}
	</ol>
</section>

{#each features as feature (feature.id)}
	{@const chapter = chapters[feature.id]}
	{@const single = chapter.bentos.length === 1}
	<section
		id={feature.id}
		class="chapter scroll-mt-[calc(var(--nav-bar-offset)+1.5rem)] tone-{chapter.tone} {chapter.dark
			? 'bg-dark-blue text-white'
			: ''}"
		aria-labelledby="{feature.id}-title"
	>
		<div
			class="mx-auto w-full max-w-8xl px-(--panel-padding) {chapter.dark
				? 'py-24 md:py-32'
				: 'pb-24 md:pb-32'}"
		>
			<div
				class="grid gap-x-16 gap-y-12 lg:grid-cols-12 {single ? 'items-center' : ''} {chapter.dark
					? ''
					: 'border-t border-dark-blue/15 pt-14 md:pt-20'}"
			>
				<header
					class="reveal {single ? 'lg:col-span-5' : 'lg:col-span-12'} {feature.id === 'router'
						? 'lg:order-2'
						: ''}"
				>
					<div class={single ? '' : 'grid items-end gap-x-16 gap-y-6 lg:grid-cols-12'}>
						<div class={single ? '' : 'lg:col-span-7'}>
							<p
								class="flex items-center gap-3 font-mono text-[12px] tracking-[0.16em] uppercase {chapter.dark
									? 'text-white/60'
									: 'text-dark-blue/60'}"
							>
								<span class="relative size-6 shrink-0 overflow-hidden" aria-hidden="true">
									<PatternGlyph concept={chapter.glyph} cell={2} />
								</span>
								{feature.eyebrow}
							</p>
							<h2
								id="{feature.id}-title"
								class="mt-5 font-noto-serif text-[clamp(2.25rem,4.4vw,3rem)] leading-[1] font-semibold tracking-[-0.035em] text-balance"
							>
								{feature.title}
							</h2>
						</div>
						<p
							class="mt-6 max-w-xl font-jakarta text-[clamp(1.0625rem,1.3vw,1.1875rem)] leading-relaxed {chapter.dark
								? 'text-white/75'
								: 'text-dark-blue/80'} {single ? '' : 'lg:col-span-5 lg:mt-0 lg:max-w-md'}"
						>
							{feature.body}
						</p>
					</div>
				</header>

				<div
					class="reveal {single ? 'lg:col-span-7' : 'lg:col-span-12'} {feature.id === 'router'
						? 'lg:order-1'
						: ''}"
				>
					<ThemeProvider mode="light" theme="alpha" contents>
						<div
							class="pat-field {chapter.kind === 'tiles' ? 'pat-field-tiles' : ''} {chapter.dark
								? 'pat-field-dark'
								: ''} p-3 sm:p-6 md:p-10"
							style:--pat-cell={chapter.kind === 'tiles' ? '26px' : '20px'}
							use:spotlight
						>
							<div
								class="bold-bentos grid gap-4 {chapter.bentos.length === 3
									? 'lg:grid-cols-3'
									: chapter.bentos.length === 2
										? 'md:grid-cols-2'
										: ''}"
							>
								{#each chapter.bentos as Bento, i (i)}<Bento />{/each}
							</div>
						</div>
					</ThemeProvider>
				</div>
			</div>
		</div>
	</section>
{/each}

<style>
	/* The app's bento tiles, framed for this look: white, square, a hairline ring and a serif title,
	   standing on the chapter's pattern field. */
	.bold-bentos :global(article[data-bento]) {
		border: 0;
		border-radius: 0;
		background: var(--white);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--dark-blue) 14%, transparent),
			0 24px 60px -36px rgb(11 37 47 / 0.45);
	}

	.bold-bentos :global(article[data-bento])::before {
		display: none;
	}

	/* The tile's icon sits in a square of the chapter's tone, the way the pattern sheet's swatches do. */
	.bold-bentos :global(article[data-bento] > div:first-child > span:first-child) {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		margin-bottom: 0.75rem;
		background: var(--tone);
		color: var(--tone-ink, var(--dark-blue));
	}

	.bold-bentos :global(article[data-bento] > div:first-child > span:first-child svg) {
		width: 1.5rem;
		height: 1.5rem;
	}

	.bold-bentos :global(article[data-bento] > div:first-child h3) {
		font-family: var(--font-noto-serif);
		font-size: 1.875rem;
		font-weight: 600;
		line-height: 1.05;
		letter-spacing: -0.035em;
		color: var(--dark-blue);
	}

	.bold-bentos :global(article[data-bento] > div:first-child p) {
		color: color-mix(in srgb, var(--dark-blue) 78%, transparent);
	}
</style>
