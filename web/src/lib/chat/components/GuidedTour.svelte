<script lang="ts">
	import { untrack } from 'svelte';
	import { on } from 'svelte/events';
	import { prefersReducedMotion } from 'svelte/motion';
	import { Button, Dialog, getAppShell, useCompact } from '@aipotluck/alpha-ds';
	import { m } from '$lib/paraglide/messages.js';
	import { tour } from '$lib/chat/tour/tour.svelte';
	import { placeCard, visibleTarget, type Rect } from '$lib/chat/tour/steps';
	import RiCloseLine from '~icons/ri/close-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import RiCompass3Line from '~icons/ri/compass-3-line';

	/**
	 * The guided tour: a ring around one feature at a time, the page dimmed around it, and a card
	 * beside it saying what the feature is, with Back, Next and a "try it" that opens the feature.
	 * Trying one pauses the tour behind a "Resume tour" chip. Nothing on the page is blocked: the
	 * highlighted feature can be used directly, and Escape ends the tour.
	 *
	 * The ring and card follow their element every frame while the tour is open, so a panel opening,
	 * a resize or a scroll never leaves them pointing at empty space.
	 *
	 * On a phone the sidebar is a drawer, slid off screen while closed, so a stop in it (Get involved)
	 * opens the drawer and the next stop, or the tour's end, closes it again. The tour's layer is
	 * portalled out of the conversation column, which the open drawer pushes aside, fades and stops
	 * taking clicks.
	 */
	const reduceMotion = $derived(prefersReducedMotion.current);

	let cardEl = $state<HTMLDivElement | null>(null);
	let ring = $state<(Rect & { radius: string }) | null>(null);
	let cardPos = $state<{ top: number; left: number } | null>(null);
	let primaryEl = $state<HTMLElement | null>(null);

	const step = $derived(tour.paused ? undefined : tour.step);
	const isLast = $derived(tour.index >= tour.steps.length - 1);

	const shell = getAppShell();
	const compact = useCompact();
	let drawerOpenedByTour = false;
	$effect(() => {
		const current = step;
		const active = tour.active;
		const phone = compact.current;
		untrack(() => {
			if (!active) {
				if (drawerOpenedByTour) shell.setMobileOpen(false);
				drawerOpenedByTour = false;
				return;
			}
			// Paused on a try-it: leave the drawer as the feature needs it.
			if (!current || !phone) return;
			const want = current.inSidebar === true;
			if (shell.mobileOpen === want) return;
			shell.setMobileOpen(want);
			drawerOpenedByTour = want;
		});
	});

	// Follow the current stop's element; drop a stop whose element has gone (a resize hid the sidebar,
	// the phone's drawer closed) rather than ringing nothing.
	$effect(() => {
		const current = step;
		if (!current) {
			ring = null;
			cardPos = null;
			return;
		}
		let frame = 0;
		const PAD = 6;
		const follow = () => {
			const el = visibleTarget(current.selector);
			if (!el) {
				tour.drop();
				return;
			}
			const r = el.getBoundingClientRect();
			const radius = getComputedStyle(el).borderRadius;
			const next = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
			if (
				!ring ||
				ring.top !== next.top ||
				ring.left !== next.left ||
				ring.width !== next.width ||
				ring.height !== next.height
			) {
				ring = { ...next, radius: radius === '0px' ? '0px' : `calc(${radius} + ${PAD}px)` };
			}
			if (cardEl) {
				const pos = placeCard(next, { width: cardEl.offsetWidth, height: cardEl.offsetHeight }, {
					width: window.innerWidth,
					height: window.innerHeight
				});
				if (!cardPos || cardPos.top !== pos.top || cardPos.left !== pos.left) cardPos = { top: pos.top, left: pos.left };
			}
			frame = requestAnimationFrame(follow);
		};
		// The element may be just off screen (the footprint on a scrolled page): bring it into view once.
		// Not one in the phone's drawer, which is off screen until the drawer has slid open.
		if (!(current.inSidebar && compact.current)) visibleTarget(current.selector)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
		frame = requestAnimationFrame(follow);
		return () => cancelAnimationFrame(frame);
	});

	// Each stop moves focus to its main button once, so the keyboard walks the tour without hunting.
	// The card stays invisible (and so unfocusable) until it has a position, so this waits for that.
	let focusedStep: string | undefined;
	$effect(() => {
		const el = primaryEl;
		const id = step?.id;
		if (!id || !el || !cardPos) {
			if (!id) focusedStep = undefined;
			return;
		}
		if (focusedStep === id) return;
		focusedStep = id;
		el.focus({ preventScroll: true });
	});

	$effect(() => {
		if (!tour.active) return;
		return on(window, 'keydown', (e) => {
			if (e.key === 'Escape' && !tour.paused) {
				e.preventDefault();
				tour.finish('dismissed');
			}
		});
	});

	function tryIt() {
		const current = step;
		if (!current?.cta) return;
		const el = visibleTarget(current.cta.selector ?? current.selector);
		tour.pause();
		el?.click();
	}

	// Back from trying a feature: close what the "try it" opened (a pill's panel, the footprint's
	// popover), then go on to the next stop.
	function resume() {
		const current = tour.step;
		const el = current ? visibleTarget(current.selector) : undefined;
		if (el?.getAttribute('aria-expanded') === 'true') el.click();
		tour.resume();
	}
</script>

<!-- Out of the conversation column: the phone's open drawer pushes it aside and fades it. -->
<Dialog.Portal>
	{#if tour.active && tour.paused}
		<div class="tour-chip-corner pointer-events-none fixed z-popover flex">
			<div
				class="tour-chip tour-chip-accent pointer-events-auto flex items-center gap-1 bg-surface-3 py-1 pr-1 pl-3 rounded-pill"
				data-tour-resume
			>
				<RiCompass3Line aria-hidden="true" class="size-4 shrink-0 text-accent-1" />
				<Button shape="pill" variant="ghost" size="sm" casing="sentence" onclick={resume} data-tour-resume-button>
					{m.tour_resume({ step: tour.index + 2, total: tour.steps.length })}
					<RiArrowRightLine aria-hidden="true" />
				</Button>
				<Button shape="pill" variant="ghost" size="icon-xs" aria-label={m.tour_end()} onclick={() => tour.finish('dismissed')}>
					<RiCloseLine aria-hidden="true" />
				</Button>
			</div>
		</div>
	{/if}

	{#if step}
		{#if ring}
			<div
				class="tour-ring pointer-events-none fixed z-overlay"
				class:tour-ring-moves={!reduceMotion}
				style:--tour-top="{ring.top}px"
				style:--tour-left="{ring.left}px"
				style:--tour-width="{ring.width}px"
				style:--tour-height="{ring.height}px"
				style:--tour-radius={ring.radius}
				aria-hidden="true"
				data-tour-ring
			></div>
		{/if}
		<div
			bind:this={cardEl}
			role="dialog"
			aria-modal="false"
			aria-labelledby="tour-title"
			aria-describedby="tour-body"
			class="tour-card fixed z-popover flex w-80 flex-col gap-3 bg-surface-3 p-4 shadow-popover rounded-popup"
			class:tour-card-moves={!reduceMotion}
			class:invisible={!cardPos}
			style:--tour-top="{cardPos?.top ?? 0}px"
			style:--tour-left="{cardPos?.left ?? 0}px"
			data-tour-card={step.id}
		>
			{#key step.id}
				<div class="flex flex-col gap-1.5 pr-6" class:tour-step-in={!reduceMotion}>
					<span class="type-label text-fg-3" data-tour-progress>
						{m.tour_progress({ step: tour.index + 1, total: tour.steps.length })}
					</span>
					<h2 id="tour-title" class="type-body font-medium text-fg-1">{step.title()}</h2>
					<p id="tour-body" class="type-caption text-fg-2">{step.body()}</p>
				</div>
			{/key}
			<div class="flex items-center gap-1" aria-hidden="true">
				{#each tour.steps as s, i (s.id)}
					<span class="h-1 rounded-pill transition-control {i === tour.index ? 'w-4 bg-accent-1' : 'w-1.5 bg-line-3'}"></span>
				{/each}
			</div>
			<div class="flex flex-wrap items-center justify-end gap-2">
				{#if tour.index > 0}
					<Button variant="ghost" size="sm" casing="sentence" class="mr-auto" onclick={() => tour.back()} data-tour-back>
						{m.tour_back()}
					</Button>
				{/if}
				{#if step.cta}
					<Button bind:ref={primaryEl} variant="primary" size="sm" casing="sentence" onclick={tryIt} data-tour-cta>
						{step.cta.label()}
					</Button>
					<Button variant="secondary" size="sm" casing="sentence" onclick={() => tour.next()} data-tour-next>
						{isLast ? m.tour_done() : m.tour_next()}
					</Button>
				{:else}
					<Button bind:ref={primaryEl} variant="primary" size="sm" casing="sentence" onclick={() => tour.next()} data-tour-next>
						{isLast ? m.tour_done() : m.tour_next()}
					</Button>
				{/if}
			</div>
			<Button
				variant="ghost"
				size="icon-xs"
				class="absolute top-2 right-2"
				aria-label={m.tour_end()}
				onclick={() => tour.finish('dismissed')}
				data-tour-close
			>
				<RiCloseLine aria-hidden="true" />
			</Button>
		</div>
	{/if}
</Dialog.Portal>

<style>
	/* The page dims around the ring: one huge spread shadow, which never blocks a click. The pulse
	   animates only the middle shadow; every keyframe lists the same three, in the same order, since
	   shadows interpolate pairwise and a mismatched list blends the dimming into the glow. */
	.tour-ring,
	.tour-card {
		top: var(--tour-top);
		left: var(--tour-left);
	}
	.tour-ring {
		width: var(--tour-width);
		height: var(--tour-height);
		border-radius: var(--tour-radius);
		--tour-dim: 0 0 0 9999px color-mix(in oklch, var(--ds-bg-chrome) 55%, transparent);
		box-shadow:
			0 0 0 2px var(--ds-accent-1),
			0 0 0 2px transparent,
			var(--tour-dim);
	}
	.tour-ring-moves {
		transition:
			top 320ms var(--ds-ease-standard),
			left 320ms var(--ds-ease-standard),
			width 320ms var(--ds-ease-standard),
			height 320ms var(--ds-ease-standard);
		animation: tour-ring-pulse 2.4s var(--ds-ease-standard) infinite;
	}
	/* Never wider than the window, less its 12px edges (placeCard's EDGE). */
	.tour-card {
		max-width: calc(100vw - 24px);
	}
	.tour-card-moves {
		transition:
			top 320ms var(--ds-ease-standard),
			left 320ms var(--ds-ease-standard);
	}
	.tour-step-in {
		animation: tour-step-in 260ms var(--ds-ease-standard) both;
	}
	/* Resume sits in the bottom-right corner, above the composer while it is docked there (the
	   clearance ChatWindow publishes for toasts), so it never covers the message box or Send. */
	.tour-chip-corner {
		right: 16px;
		bottom: calc(var(--toast-clearance, 0px) + 16px + env(safe-area-inset-bottom, 0px));
		max-width: calc(100vw - 32px);
	}
	/* An accent ring over the popover shadow (listed first, so it sits on top of the popover's own
	   hairline rather than beside it), with a soft halo that breathes, so the paused tour is easy to
	   find again. Every keyframe lists the same shadows in the same order. */
	.tour-chip-accent {
		box-shadow:
			0 0 0 1.5px var(--ds-accent-1),
			0 0 0 4px color-mix(in oklch, var(--ds-accent-1) 18%, transparent),
			var(--ds-shadow-popover);
	}
	@media (prefers-reduced-motion: no-preference) {
		/* Two classes, so it wins over the plain chip's entrance-only animation. */
		.tour-chip.tour-chip-accent {
			animation:
				tour-step-in 260ms var(--ds-ease-standard) both,
				tour-chip-breathe 2.4s var(--ds-ease-standard) 260ms infinite;
		}
	}
	@keyframes tour-chip-breathe {
		0%,
		100% {
			box-shadow:
				0 0 0 1.5px var(--ds-accent-1),
				0 0 0 4px color-mix(in oklch, var(--ds-accent-1) 18%, transparent),
				var(--ds-shadow-popover);
		}
		50% {
			box-shadow:
				0 0 0 1.5px var(--ds-accent-1),
				0 0 0 8px color-mix(in oklch, var(--ds-accent-1) 8%, transparent),
				var(--ds-shadow-popover);
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.tour-chip {
			animation: tour-step-in 260ms var(--ds-ease-standard) both;
		}
	}
	@keyframes tour-ring-pulse {
		0%,
		100% {
			box-shadow:
				0 0 0 2px var(--ds-accent-1),
				0 0 0 2px transparent,
				var(--tour-dim);
		}
		50% {
			box-shadow:
				0 0 0 2px var(--ds-accent-1),
				0 0 0 7px color-mix(in oklch, var(--ds-accent-1) 25%, transparent),
				var(--tour-dim);
		}
	}
	@keyframes tour-step-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
