<script lang="ts">
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import type { Component } from 'svelte';
	import { getAlphaLandingContent } from './content.svelte';
	import type { FeatureId } from './copy';
	const readContent = getAlphaLandingContent();
	const features = $derived(
		readContent().features.map(({ key, ...feature }) => ({ ...feature, id: key }))
	);

	let { variant = 'sharp' }: { variant?: 'soft' | 'sharp' | 'bold' } = $props();

	// One class set per landing look (looks/looks.ts).
	const styles = {
		soft: {
			list: 'border border-grid-line bg-white/95 p-1 shadow-[0_16px_40px_-24px_rgba(11,37,47,0.5)] backdrop-blur-sm',
			active: 'bg-dark-blue text-white',
			idle: 'text-dark-blue/70 hover:text-dark-blue'
		},
		sharp: {
			list: 'border-2 border-dark-blue bg-white p-1 shadow-[0px_10px_30px_0px_rgba(0,0,0,0.08)]',
			active: 'bg-dark-blue text-white',
			idle: 'text-dark-blue/70 hover:text-dark-blue'
		},
		bold: {
			list: 'bg-dark-blue p-1.5 shadow-[0_24px_60px_-24px_rgba(11,37,47,0.8)]',
			active: 'bg-[#e9897b] text-white',
			idle: 'text-white/70 hover:text-white'
		}
	} as const;
	const style = $derived(styles[variant]);

	const icons: Record<FeatureId, Component> = {
		language: LanguagesIcon,
		data: DatabaseIcon,
		rules: SlidersHorizontalIcon,
		router: NetworkIcon
	};

	let activeId = $state<FeatureId>('language');
	let featuresInView = $state(false);
	let footerInView = $state(false);
	const navVisible = $derived(featuresInView && !footerInView);

	// The jumper belongs to the feature band. Wait until that band's first
	// section has reached the upper half of the viewport, so it does not
	// cover the reply illustration on a short screen.
	function syncFeatures() {
		const firstId = features[0]?.id;
		const first = firstId ? document.getElementById(firstId) : null;
		featuresInView = !!first && first.getBoundingClientRect().top < window.innerHeight * 0.45;
	}

	$effect(() => {
		const sections = features
			.map((feature) => document.getElementById(feature.id))
			.filter((element): element is HTMLElement => element !== null);
		const footer = document.querySelector('footer');

		const sectionObserver = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
				const id = visible?.target.id;
				if (id && features.some((feature) => feature.id === id)) {
					activeId = id as FeatureId;
				}
			},
			{ rootMargin: '-30% 0px -45% 0px', threshold: [0.15, 0.4, 0.75] }
		);

		const footerObserver = new IntersectionObserver(
			(entries) => {
				footerInView = entries.some((entry) => entry.isIntersecting);
			},
			{ threshold: 0.08 }
		);
		syncFeatures();

		for (const section of sections) sectionObserver.observe(section);
		if (footer) footerObserver.observe(footer);

		return () => {
			sectionObserver.disconnect();
			footerObserver.disconnect();
		};
	});
</script>

<svelte:window onscroll={syncFeatures} onresize={syncFeatures} />

<nav
	aria-label="On this page"
	aria-hidden={!navVisible}
	class="fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 transition-opacity duration-200 {navVisible
		? 'opacity-100'
		: 'pointer-events-none opacity-0'}"
>
	<ul class="flex max-w-full gap-1 overflow-x-auto {style.list}">
		{#each features as feature (feature.id)}
			{@const Icon = icons[feature.id]}
			<li class="shrink-0">
				<a
					href="#{feature.id}"
					aria-current={activeId === feature.id ? 'true' : undefined}
					class="flex items-center gap-1.5 px-3 py-2 font-jakarta text-[12px] font-semibold tracking-tight transition-colors {activeId ===
					feature.id
						? style.active
						: style.idle}"
				>
					<Icon class="size-3.5" aria-hidden="true" />
					{feature.nav}
				</a>
			</li>
		{/each}
	</ul>
</nav>
