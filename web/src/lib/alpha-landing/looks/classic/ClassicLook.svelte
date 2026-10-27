<script lang="ts">
	import AlphaFaq from './ClassicFaq.svelte';
	import AlphaFeatures from './ClassicFeatures.svelte';
	import AlphaHeroBackdrop from './ClassicHeroBackdrop.svelte';
	import AlphaSectionNav from '../../AlphaSectionNav.svelte';
	import AlphaDemoShell from '../../AlphaDemoShell.svelte';
	import { getAlphaLandingContent } from '../../content.svelte';
	const readContent = getAlphaLandingContent();
	const hero = $derived(readContent().hero);
	import { Button } from '$lib/components/ui/button';
</script>

<main class="relative w-full flex-1 overflow-x-clip bg-paper pb-28">
	<section class="alpha-hero-stage relative isolate w-full">
		<AlphaHeroBackdrop />
		<div
			class="relative z-[1] mx-auto flex w-full max-w-8xl flex-col px-(--panel-padding) pt-(--page-top-padding)"
		>
			<div
				class="alpha-hero-region mx-auto flex w-full max-w-[1240px] flex-col items-center pt-6 pb-8 md:pt-10 md:pb-12"
			>
				<header
					class="alpha-hero-copy relative mx-auto flex max-w-3xl flex-col items-center pb-10 text-center md:pb-11"
				>
					<span class="mb-6 inline-block size-3 rotate-45 bg-salmon" aria-hidden="true"></span>
					<p
						class="font-jakarta text-[12px] font-semibold tracking-[0.18em] text-dark-blue/50 uppercase"
					>
						Alpha
					</p>
					<h1
						class="mt-4 font-noto-serif text-[clamp(2.6rem,6vw,4.5rem)] leading-[1.05] font-semibold tracking-tight text-balance text-dark-blue [text-shadow:0_0_24px_color-mix(in_srgb,var(--paper)_88%,transparent)]"
					>
						{hero.headline}
					</h1>
					<p
						class="mt-3 font-noto-serif text-[clamp(1.05rem,2.4vw,1.35rem)] leading-snug font-medium tracking-tight text-balance text-dark-blue/75 [text-shadow:0_0_20px_color-mix(in_srgb,var(--paper)_88%,transparent)]"
					>
						{hero.tagline}
					</p>
					<p class="mt-6 max-w-xl font-jakarta text-[17px] leading-7 text-dark-blue/80">
						{hero.sub}
					</p>
					<div class="mt-8 flex flex-wrap items-center justify-center gap-3">
						<!-- eslint-disable svelte/no-navigation-without-resolve -- /chat is the CMS chat page, not a typed file route -->
						<Button href={hero.ctaHref}>{hero.cta}</Button>
						<Button href="/alpha/demo?look=classic" variant="light" data-hero-try-demo
							>{hero.demoCta}</Button
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</div>
				</header>

				<div class="relative w-full">
					<AlphaDemoShell frame="soft" />
				</div>
			</div>
		</div>
	</section>

	<div class="mx-auto flex w-full max-w-8xl flex-col px-(--panel-padding)">
		<div id="alpha-sections" class="mt-16 md:mt-24">
			<AlphaFeatures />
			<AlphaFaq />
		</div>
	</div>
</main>

<AlphaSectionNav variant="soft" />

<style>
	.alpha-hero-stage {
		overflow: hidden;
	}

	.alpha-hero-region {
		position: relative;
	}

	.alpha-hero-copy::before {
		content: '';
		position: absolute;
		inset: -2rem -3rem -0.5rem;
		z-index: -1;
		pointer-events: none;
		background: radial-gradient(
			ellipse 90% 70% at 50% 40%,
			color-mix(in srgb, var(--paper) 78%, transparent) 0%,
			transparent 72%
		);
	}
</style>
