<script lang="ts">
	import type { Component } from 'svelte';
	import { getAlphaLandingContent } from '../../content.svelte';
	import type { FeatureId } from '../../copy';
	const readContent = getAlphaLandingContent();
	const features = $derived(
		readContent().features.map(({ key, ...feature }) => ({ ...feature, id: key }))
	);
	const sectionsIntro = $derived(readContent().sectionsIntro);
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import LanguageBento from '$lib/chat/components/bentos/LanguageBento.svelte';
	import DataBento from '$lib/chat/components/bentos/DataBento.svelte';
	import FootprintBento from '$lib/chat/components/bentos/FootprintBento.svelte';
	import ThemeBento from '$lib/chat/components/bentos/ThemeBento.svelte';
	import InstructionsBento from '$lib/chat/components/bentos/InstructionsBento.svelte';
	import ModelBento from '$lib/chat/components/bentos/ModelBento.svelte';
	import XRayBento from '$lib/chat/components/bentos/XRayBento.svelte';

	// Each section: its copy plus one or more interactive bentos built from the app's real pieces.
	// `split` puts one bento beside the copy; `grid` puts the copy on top and the bentos in a row.
	const sections: Record<
		FeatureId,
		{ layout: 'split' | 'split-reverse' | 'grid'; bentos: Component[] }
	> = {
		language: { layout: 'split', bentos: [LanguageBento] },
		data: { layout: 'grid', bentos: [DataBento, FootprintBento] },
		rules: { layout: 'grid', bentos: [ThemeBento, InstructionsBento, ModelBento] },
		router: { layout: 'split-reverse', bentos: [XRayBento] }
	};
</script>

<div class="flex flex-col">
	<div
		class="border-t border-grid-line px-1 py-12 text-center md:py-16"
		aria-labelledby="alpha-sections-intro-title"
	>
		<p class="font-jakarta text-[12px] font-semibold tracking-[0.16em] text-salmon uppercase">
			{sectionsIntro.eyebrow}
		</p>
		<h2
			id="alpha-sections-intro-title"
			class="mx-auto mt-3 max-w-2xl font-noto-serif text-[clamp(1.65rem,3.2vw,2.25rem)] leading-[1.15] font-semibold tracking-tight text-balance text-dark-blue"
		>
			{sectionsIntro.title}
		</h2>
		<p class="mx-auto mt-4 max-w-xl font-jakarta text-[16px] leading-7 text-dark-blue/80">
			{sectionsIntro.body}
		</p>
	</div>
	{#each features as feature (feature.id)}
		{@const section = sections[feature.id]}
		{#snippet copy(center: boolean)}
			<p class="font-jakarta text-[12px] font-semibold tracking-[0.16em] text-salmon uppercase">
				{feature.eyebrow}
			</p>
			<h2
				id="{feature.id}-title"
				class="mt-3 font-noto-serif text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.15] font-semibold tracking-tight text-balance text-dark-blue"
			>
				{feature.title}
			</h2>
			<p
				class="mt-4 font-jakarta text-[16px] leading-7 text-dark-blue/80 {center
					? 'mx-auto max-w-2xl'
					: 'max-w-xl'}"
			>
				{feature.body}
			</p>
		{/snippet}
		<section
			id={feature.id}
			class="scroll-mt-[calc(var(--nav-bar-offset)+1.5rem)] border-t border-grid-line py-14 md:py-20"
			aria-labelledby="{feature.id}-title"
		>
			{#if section.layout === 'grid'}
				<div class="text-center">{@render copy(true)}</div>
				<ThemeProvider mode="light" theme="alpha" contents>
					<div
						class="mt-10 grid gap-4 {section.bentos.length === 3
							? 'lg:grid-cols-3'
							: 'md:grid-cols-2'}"
					>
						{#each section.bentos as Bento, i (i)}<Bento />{/each}
					</div>
				</ThemeProvider>
			{:else}
				<div class="grid items-center gap-8 md:grid-cols-12 md:gap-12">
					<div
						class="min-w-0 md:col-span-5 {section.layout === 'split-reverse' ? 'md:order-2' : ''}"
					>
						{@render copy(false)}
					</div>
					<div
						class="min-w-0 md:col-span-7 {section.layout === 'split-reverse' ? 'md:order-1' : ''}"
					>
						<ThemeProvider mode="light" theme="alpha" contents>
							{#each section.bentos as Bento, i (i)}<Bento />{/each}
						</ThemeProvider>
					</div>
				</div>
			{/if}
		</section>
	{/each}
</div>
