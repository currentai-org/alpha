<script lang="ts">
	import './bold.css';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import AlphaDemoShell from '../../AlphaDemoShell.svelte';
	import AlphaSectionNav from '../../AlphaSectionNav.svelte';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import PackageOpenIcon from '@lucide/svelte/icons/package-open';
	import ScanEyeIcon from '@lucide/svelte/icons/scan-eye';
	import ServerIcon from '@lucide/svelte/icons/server';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { getAlphaLandingContent } from '../../content.svelte';
	import type { TickerId } from '../../copy';
	const readContent = getAlphaLandingContent();
	const hero = $derived(readContent().hero);
	const ticker = $derived(readContent().ticker.map(({ key, ...item }) => ({ ...item, id: key })));
	import BoldClosing from './BoldClosing.svelte';
	import BoldFaq from './BoldFaq.svelte';
	import BoldFeatures from './BoldFeatures.svelte';
	import BoldPatternField from './BoldPatternField.svelte';
	import PatternGlyph from './PatternGlyph.svelte';
	import PotluckMark from '$lib/chat/components/PotluckMark.svelte';

	const tickerIcons: Record<TickerId, typeof LanguagesIcon> = {
		open: PackageOpenIcon,
		hosts: ServerIcon,
		xray: ScanEyeIcon,
		language: LanguagesIcon,
		training: ShieldCheckIcon,
		erase: Trash2Icon,
		model: SlidersHorizontalIcon
	};

	const pillars = $derived([
		{ label: hero.languagePillar, glyph: 'language' },
		{ label: hero.dataPillar, glyph: 'data' },
		{ label: hero.rulesPillar, glyph: 'rules' }
	] as const);
</script>

<main class="bold-look relative w-full flex-1 overflow-x-clip bg-white text-dark-blue">
	<section class="relative isolate bg-dark-blue pt-(--page-top-padding) text-white">
		<BoldPatternField />
		<div class="relative z-[1] mx-auto w-full max-w-8xl px-(--panel-padding)">
			<header
				class="mx-auto flex max-w-5xl flex-col items-center pt-14 pb-12 text-center md:pt-20 md:pb-16"
			>
				<p
					class="flex items-center gap-3 font-mono text-[12px] tracking-[0.16em] text-white/60 uppercase"
				>
					<PotluckMark class="size-4 text-(--bold-coral)" />
					{hero.eyebrow}
				</p>
				<h1
					class="mt-7 font-noto-serif text-[clamp(3.5rem,8.6vw,8rem)] leading-[0.9] font-semibold tracking-[-0.045em] text-balance"
				>
					<span class="sr-only">{hero.headline}</span>
					<span aria-hidden="true"
						>{hero.headlineStart}
						<span class="text-(--bold-coral)"
							>{hero.headlineAccent}<span class="headline-stop" aria-hidden="true"></span></span
						></span
					>
				</h1>
				<p class="sr-only">{hero.tagline}</p>
				<ul class="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-3" aria-hidden="true">
					{#each pillars as pillar (pillar.label)}
						<li class="flex items-center gap-2.5 font-jakarta text-[17px] font-semibold">
							<span class="relative size-6 shrink-0 overflow-hidden">
								<PatternGlyph concept={pillar.glyph} cell={2} />
							</span>
							{pillar.label}
						</li>
					{/each}
				</ul>
				<p
					class="mt-6 max-w-2xl font-jakarta text-[clamp(1.0625rem,1.3vw,1.1875rem)] leading-relaxed text-white/75"
				>
					{hero.sub}
				</p>
				<div class="mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
					<!-- eslint-disable svelte/no-navigation-without-resolve -- /chat and /alpha/demo are plain route links -->
					<a
						href={hero.ctaHref}
						class="group inline-flex h-14 items-stretch bg-(--bold-coral) font-jakarta text-lg font-bold text-white transition-transform hover:-translate-y-0.5 focus-visible:ring-4 focus-visible:ring-white/40 focus-visible:outline-none"
					>
						<span class="flex items-center px-6">{hero.cta}</span>
						<span
							class="flex w-14 items-center justify-center bg-dark-blue/10 transition-colors group-hover:bg-dark-blue group-hover:text-(--bold-coral)"
						>
							<ArrowRightIcon class="size-5" strokeWidth={2.5} aria-hidden="true" />
						</span>
					</a>
					<a
						href="/alpha/demo"
						data-hero-try-demo
						class="group inline-flex items-center gap-2 font-jakarta text-lg font-semibold text-white"
					>
						<span
							class="underline decoration-white/30 decoration-2 underline-offset-[6px] transition-colors group-hover:decoration-(--bold-coral)"
							>{hero.demoCta}</span
						>
						<ArrowRightIcon
							class="size-4 transition-transform group-hover:translate-x-1"
							aria-hidden="true"
						/>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</div>
			</header>
			<div class="pb-16 md:pb-24">
				<AlphaDemoShell frame="bold" />
			</div>
		</div>

		<div
			class="relative z-[1] overflow-hidden bg-(--bold-coral) py-3.5 text-white"
			aria-hidden="true"
		>
			<div class="ticker flex w-max">
				{#each [0, 1] as copy (copy)}
					<ul class="flex shrink-0 items-center">
						{#each ticker as item (item.id)}
							{@const Icon = tickerIcons[item.id]}
							<li
								class="flex items-center gap-2.5 pr-12 font-mono text-[13px] tracking-[0.14em] whitespace-nowrap uppercase"
							>
								<Icon class="size-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
								{item.text}
							</li>
						{/each}
					</ul>
				{/each}
			</div>
		</div>
	</section>

	<div id="alpha-sections" class="mt-24 md:mt-32">
		<BoldFeatures />
		<BoldFaq />
		<BoldClosing />
	</div>
</main>

<AlphaSectionNav variant="bold" />

<style>
	.headline-stop {
		display: inline-block;
		width: 0.16em;
		height: 0.16em;
		margin-left: 0.04em;
		background: var(--bold-coral);
		clip-path: polygon(29% 0, 71% 0, 100% 29%, 100% 71%, 71% 100%, 29% 100%, 0 71%, 0 29%);
	}

	@media (prefers-reduced-motion: no-preference) {
		.ticker {
			animation: ticker 48s linear infinite;
		}
	}

	@keyframes ticker {
		to {
			translate: -50% 0;
		}
	}
</style>
