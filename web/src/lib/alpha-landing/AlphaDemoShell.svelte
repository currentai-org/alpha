<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { DEMO_READY_EVENT, useDemoTransition } from './demo-transition';
	import type { Component } from 'svelte';
	import { getAlphaLandingContent } from './content.svelte';
	const readContent = getAlphaLandingContent();
	const stage = $derived(readContent().stage);

	// The frame follows the landing look (looks/looks.ts).
	let { frame = 'sharp' }: { frame?: 'soft' | 'sharp' | 'bold' } = $props();
	// Full-screen demo mode dresses to match the look it was opened from.
	const demoHref = $derived(
		{ soft: '/alpha/demo?look=classic', sharp: '/alpha/demo?look=handover', bold: '/alpha/demo' }[
			frame
		]
	);

	// /alpha: a live, non-interactive preview of the real app, with one clear way in — "Try the demo"
	// opens dedicated demo mode (/alpha/demo), full screen, instead of trapping scroll and clicks
	// inside a window on a marketing page.
	let DemoClient = $state<Component | null>(null);
	// Grows into /alpha/demo and back (view transition on `.alpha-demo-shell`).
	useDemoTransition();

	onMount(async () => {
		const mod = await import('./AlphaDemoClient.svelte');
		DemoClient = mod.default;
		await tick();
		window.dispatchEvent(new Event(DEMO_READY_EVENT));
	});
</script>

<section id="demo" class="alpha-stage w-full scroll-mt-24" aria-label={stage.label}>
	<div class="alpha-demo-shell" data-frame={frame}>
		<div class="alpha-demo-shell__preview" inert aria-hidden="true">
			{#if DemoClient}
				<div class="flex h-full min-h-0 flex-1 flex-col">
					<DemoClient />
				</div>
			{:else}
				<div class="alpha-demo-shell__placeholder" aria-busy="true">
					<div class="alpha-demo-shell__placeholder-thread">
						<div class="ml-auto max-w-[85%] bg-paper px-4 py-3">
							<p class="font-jakarta text-[15px] leading-6 text-dark-blue">{stage.prompt}</p>
						</div>
						<div class="max-w-[90%]">
							<p class="font-jakarta text-[15px] leading-6 text-dark-blue/90">{stage.answer}</p>
						</div>
					</div>
				</div>
			{/if}
		</div>
		<!-- eslint-disable svelte/no-navigation-without-resolve -- /alpha/demo is a plain route link -->
		<a class="alpha-demo-shell__cta" href={demoHref} data-try-demo>
			<span class="alpha-demo-shell__button">{readContent().hero.demoCta}</span>
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</div>
</section>

<style>
	.alpha-stage {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 1240px;
		margin-inline: auto;
	}

	.alpha-demo-shell {
		container-type: inline-size;
		container-name: alpha-demo-shell;
		display: flex;
		flex-direction: column;
		height: min(78vh, 820px);
		min-height: 560px;
		overflow: hidden;
		border: 2px solid var(--dark-blue, #142e3e);
		background: var(--paper, #f7f6f6);
		box-shadow: 0 10px 30px 0 rgb(0 0 0 / 0.05);
	}

	.alpha-demo-shell {
		position: relative;
		view-transition-name: alpha-demo;
	}

	.alpha-demo-shell__preview {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
		user-select: none;
	}

	/* The whole preview is the link; a soft veil + one clear button. */
	.alpha-demo-shell__cta {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		gap: 0.6rem;
		padding: 2rem 1rem 2.5rem;
		background: linear-gradient(
			to top,
			color-mix(in srgb, #000 55%, transparent) 0%,
			color-mix(in srgb, #000 12%, transparent) 45%,
			transparent 70%
		);
		transition: background 0.2s ease;
	}

	.alpha-demo-shell__cta:hover,
	.alpha-demo-shell__cta:focus-visible {
		background: linear-gradient(
			to top,
			color-mix(in srgb, #000 62%, transparent) 0%,
			color-mix(in srgb, #000 22%, transparent) 50%,
			color-mix(in srgb, #000 6%, transparent) 100%
		);
	}

	.alpha-demo-shell__cta:focus-visible {
		outline: 2px solid var(--salmon, #f88376);
		outline-offset: -3px;
	}

	.alpha-demo-shell__button {
		font-family: var(--font-jakarta, ui-sans-serif, system-ui, sans-serif);
		font-size: 17px;
		font-weight: 600;
		padding: 0.7rem 1.25rem;
		color: var(--dark-blue, #142e3e);
		background: var(--salmon, #f88376);
		box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.6);
		transition: transform 0.2s ease;
	}

	.alpha-demo-shell__cta:hover .alpha-demo-shell__button {
		transform: translateY(-2px);
	}

	.alpha-demo-shell :global(.chat-window) {
		border: none;
		border-radius: 0;
		box-shadow: none;
		height: 100%;
	}

	.alpha-demo-shell__placeholder {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem 1rem;
		background: var(--paper);
	}

	.alpha-demo-shell__placeholder-thread {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1.25rem;
		padding: 0.5rem 0;
	}

	.alpha-demo-shell[data-frame='soft'] {
		border: 1px solid color-mix(in srgb, var(--dark-blue, #0b252f) 14%, transparent);
		border-radius: 18px;
		box-shadow:
			0 1px 2px color-mix(in srgb, var(--dark-blue, #0b252f) 8%, transparent),
			0 30px 80px -40px color-mix(in srgb, var(--dark-blue, #0b252f) 45%, transparent);
	}

	.alpha-demo-shell[data-frame='soft'] .alpha-demo-shell__button {
		font-size: 15px;
		padding: 0.8rem 1.5rem;
		border-radius: 999px;
		color: var(--dark-blue, #0b252f);
		background: var(--paper, #f7f6f6);
	}

	.alpha-demo-shell[data-frame='soft'] .alpha-demo-shell__cta:focus-visible {
		border-radius: 18px;
	}

	.alpha-demo-shell[data-frame='bold'] {
		border: 0;
		box-shadow:
			0 0 0 1px rgb(255 255 255 / 0.14),
			0 50px 120px -40px rgb(0 0 0 / 0.7);
	}

	.alpha-demo-shell[data-frame='bold'] .alpha-demo-shell__button {
		background: var(--bold-coral, #e9897b);
		color: var(--white, #fff);
	}

	@container alpha-demo-shell (max-width: 640px) {
		.alpha-demo-shell {
			height: min(72vh, 680px);
			min-height: 420px;
		}
	}
</style>
