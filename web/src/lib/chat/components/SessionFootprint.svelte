<script lang="ts">
	import { Badge, Button, Collapsible, Meter, Popover, Sheet, useCompact } from '@aipotluck/alpha-ds';
	import RiFlashlightLine from '~icons/ri/flashlight-line';
	import RiTimeLine from '~icons/ri/time-line';
	import RiLightbulbFlashLine from '~icons/ri/lightbulb-flash-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import RiCheckLine from '~icons/ri/check-line';
	import RiCloseLine from '~icons/ri/close-line';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { resolveServing } from '$lib/chat/servingProvenance';
	import { useSessionFootprintStore } from '$lib/chat/stores/sessionFootprint.svelte';
	import {
		formatEnergy,
		formatElapsedShort,
		formatEnergyShort,
		estimateEnergyBandWh,
		energyBreakdown,
		TYPICAL_AI_PROMPT_WH
	} from '$lib/chat/utils/energyEstimate';
	import { localizedAnchor, localizedBulbShort, localizedComparison, localizedElapsed } from '$lib/chat/utils/energyCopy';
	import { trackEvent } from '$lib/analytics';
	import { deleteAllOpen, deleteAllAnchor, deleteAllMode } from '$lib/chat/stores/deleteAll';

	/**
	 * This session's footprint: the energy your replies cost and the time you've spent, shown on
	 * purpose (Alpha doesn't optimise to keep you here). The trigger is just two icon + value pairs;
	 * the popover leads with the one-line summary, then the two figures, the energy scale, why we show
	 * this, and — one tap deeper — how it's estimated.
	 */
	interface Props {
		/** Mobile row under the header: smaller trigger. */
		compact?: boolean;
		/** Marketing embed: reset fixture data only — never open the real GDPR wipe modal. */
		embeddedDemo?: boolean;
		/** Show "Forget everything" beside the stats. Off in the chat (it lives in Settings → Data & privacy). */
		forget?: boolean;
		onDemoForgetEverything?: () => void;
	}

	let { compact = false, embeddedDemo = false, forget = true, onDemoForgetEverything }: Props = $props();

	const footprint = useSessionFootprintStore();
	// The datacenter clause below must not claim "several Swiss backends" unless the serving
	// config says so — derived from the one flag every "may this surface name Switzerland" reads. (CUR-1389)
	const serving = $derived(page.data.servingProvenance ?? resolveServing());

	let open = $state(false);
	const phone = useCompact();
	let methodOpen = $state(false);
	let sheetEl = $state<HTMLDivElement | null>(null);
	let forgetBtnEl = $state<HTMLElement | null>(null);

	const elapsed = $derived(localizedElapsed(footprint.elapsedMs));
	const comparison = $derived(localizedComparison(footprint.energyWh));
	const band = $derived(estimateEnergyBandWh(footprint.outputTokens));
	const energyShort = $derived(formatEnergyShort(footprint.energyWh));
	// The meter fills toward an everyday amount (a phone charge, a laptop charge, a kettle boil).
	const anchor = $derived(localizedAnchor(footprint.energyWh));
	const anchorShare = $derived(footprint.energyWh / anchor.wh);

	// Methodology visuals — all derived from energyEstimate's constants and this session's figures.
	const shares = energyBreakdown();
	const parts = $derived([
		{ key: 'compute', label: m.chat_energyPartCompute(), what: m.chat_energyPartComputeWhat(), share: shares.compute, cls: 'bg-accent-1' },
		{ key: 'idle', label: m.chat_energyPartIdle(), what: m.chat_energyPartIdleWhat(), share: shares.idle, cls: 'bg-accent-1/55' },
		{ key: 'overhead', label: m.chat_energyPartOverhead(), what: m.chat_energyPartOverheadWhat(), share: shares.overhead, cls: 'bg-accent-1/25' }
	]);
	const partsLabel = $derived(parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(', '));
	// Log-scale positions for the uncertainty band (it spans ~10×).
	const rangePos = $derived.by(() => {
		const lo = Math.max(band.lo, 1e-6);
		const hi = Math.max(band.hi, lo * 1.0001);
		const min = Math.log10(lo) - 0.3;
		const max = Math.log10(hi) + 0.3;
		const pos = (v: number) => ((Math.log10(Math.max(v, 1e-6)) - min) / (max - min)) * 100;
		return { lo: pos(lo), hi: pos(hi), mid: pos(footprint.energyWh) };
	});
	const spread = $derived(Math.round(band.hi / Math.max(band.lo, 1e-9)));
	const scaleRows = $derived([
		{ label: m.chat_energyScaleSession(), wh: footprint.energyWh, cls: 'bg-accent-1' },
		{ label: m.chat_energyScaleTypical(), wh: TYPICAL_AI_PROMPT_WH, cls: 'bg-fg-3' }
	]);
	const scaleMax = $derived(Math.max(...scaleRows.map((r) => r.wh), 1e-6));
	const counted = $derived([
		m.chat_energyCountedModel(),
		m.chat_energyCountedIdle(),
		m.chat_energyCountedCooling(),
		m.chat_energyCountedSecondOpinion()
	]);
	const notCounted = $derived([
		m.chat_energyNotCountedHardware(),
		m.chat_energyNotCountedTraining(),
		m.chat_energyNotCountedSearch(),
		m.chat_energyNotCountedVoice()
	]);
	const timeShort = $derived(formatElapsedShort(footprint.elapsedMs));

	$effect(() => {
		if (open) trackEvent('session_timer_clicked', {});
	});

	function openDeleteAll() {
		if (embeddedDemo) {
			footprint.reset();
			onDemoForgetEverything?.();
			return;
		}
		deleteAllAnchor.set(forgetBtnEl ?? undefined);
		deleteAllMode.set('data');
		deleteAllOpen.set(true);
	}

	// First reply of the session: a brief accent pulse on the trigger, so the figures are noticed
	// without a permanent billboard. Skipped when the session already had activity at mount.
	const startedWithActivity = footprint.hasActivity;
	let hasRevealed = false;
	let revealing = $state(false);
	$effect(() => {
		if (footprint.hasActivity && !startedWithActivity && !hasRevealed) {
			hasRevealed = true;
			revealing = true;
			setTimeout(() => (revealing = false), 3000);
		}
	});

	// Each time a figure moves after the first reading (a reply's energy, another minute online), the
	// new value rolls in and its icon glints, so the numbers read as live without a constant animation.
	// The counters key the figures, so each change remounts them and replays the CSS animation once.
	let energyTick = $state(0);
	let timeTick = $state(0);
	let lastEnergy: string | undefined;
	let lastTime: string | undefined;
	// The figures alone go unnoticed. After each reply the trigger says, for a few seconds,
	// what that reply cost in everyday terms ("a light bulb for 3 s"). It grows inside the trigger rather
	// than floating over the thread: a card floating over the messages would cover the Edit box (CUR-1925). (CUR-4266)
	let lastEnergyWh: number | undefined;
	let replyNote = $state<string | null>(null);
	let replyNoteTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		if (!footprint.started) return;
		if (lastEnergy !== undefined && energyShort !== lastEnergy) energyTick = untrack(() => energyTick) + 1;
		lastEnergy = energyShort;
		const wh = footprint.energyWh;
		if (lastEnergyWh !== undefined && wh > lastEnergyWh) {
			replyNote = localizedBulbShort(wh - lastEnergyWh);
			clearTimeout(replyNoteTimer);
			replyNoteTimer = setTimeout(() => (replyNote = null), 5000);
		}
		lastEnergyWh = wh;
	});
	$effect(() => () => clearTimeout(replyNoteTimer));
	$effect(() => {
		if (!footprint.started) return;
		if (lastTime !== undefined && timeShort !== lastTime) timeTick = untrack(() => timeTick) + 1;
		lastTime = timeShort;
	});
</script>

{#snippet triggerBody()}
			<!-- The server has no sessionStorage, so its store reads zero: the figures stay hidden until the
			     browser's store has loaded, or a reload flashes "0Wh" over a session that used energy (CUR-1890). -->
			<span
				class="flex items-center gap-1 tabular-nums"
				class:text-fg-1={footprint.hasActivity && !revealing}
				class:text-accent-1-text={revealing}
				class:invisible={!footprint.started}
			>
				{#key energyTick}
					<span class="flex items-center gap-1" class:footprint-glint={energyTick > 0}>
						<RiFlashlightLine
							aria-hidden="true"
							class={revealing
								? 'text-accent-1 motion-safe:animate-pulse'
								: footprint.hasActivity
									? 'text-accent-1'
									: 'text-fg-3'}
						/>
						<span class:footprint-roll={energyTick > 0}>{energyShort}</span>
					</span>
				{/key}
			</span>
			{#if replyNote}
				<!-- The trigger's aria-label carries the figures; the note is a visual flourish on top of them. -->
				<span class="footprint-note flex" aria-hidden="true" data-footprint-reply-note>
					<Badge tone="accent"><RiLightbulbFlashLine aria-hidden="true" />{replyNote}</Badge>
				</span>
			{/if}
			<span class="flex items-center gap-1 tabular-nums" class:invisible={!footprint.started}>
				{#key timeTick}
					<span class="flex" class:footprint-tock={timeTick > 0}><RiTimeLine aria-hidden="true" class="text-fg-3" /></span>
					<span class:footprint-roll={timeTick > 0}>{timeShort}</span>
				{/key}
			</span>
{/snippet}

{#snippet breakdown()}
						<header class="flex flex-col gap-1">
							<span class="type-label text-fg-3 max-md:hidden">{m.chat_thisSession()}</span>
							<h2 class="type-heading text-fg-1">{m.chat_footprintHeading({ elapsed })}</h2>
						</header>

						<div class="grid grid-cols-2 gap-2">
							<div class="flex flex-col gap-1 border border-line-2 p-3 rounded-card">
								<span class="flex items-center gap-1.5 type-caption text-fg-2">
									<RiFlashlightLine aria-hidden="true" class="size-3.5 text-accent-1" /> {m.chat_energy()}
								</span>
								<span class="type-title text-fg-1 tabular-nums">{energyShort}</span>
								<span class="type-caption text-fg-3">{m.chat_estimated()}</span>
							</div>
							<div class="flex flex-col gap-1 border border-line-2 p-3 rounded-card">
								<span class="flex items-center gap-1.5 type-caption text-fg-2">
									<RiTimeLine aria-hidden="true" class="size-3.5 text-accent-1" /> {m.chat_timeOnline()}
								</span>
								<span class="type-title text-fg-1 tabular-nums">{timeShort}</span>
								<span class="type-caption text-fg-3">{m.chat_thisSessionLower()}</span>
							</div>
						</div>

						{#if footprint.hasActivity}
							<p class="type-body text-fg-1">{comparison}</p>
							<Meter.Root value={footprint.energyWh} max={anchor.wh} format={() => energyShort}>
								<Meter.Label>{m.chat_comparedWith({ anchor: anchor.label })}</Meter.Label>
								<Meter.Value />
								<Meter.Track><Meter.Indicator tone="accent" /></Meter.Track>
							</Meter.Root>
							<div class="-mt-3 flex justify-between type-caption text-fg-3">
								<span>0</span><span>{anchor.short} (≈{anchor.wh} Wh)</span>
							</div>
							<p class="-mt-2 type-caption text-fg-2" data-energy-anchor>
								{anchorShare < 0.01
									? m.chat_anchorShareTiny({ anchor: anchor.label })
									: m.chat_anchorShare({ percent: Math.round(anchorShare * 100), anchor: anchor.label })}
							</p>
						{/if}

						<p class="border-l-2 border-accent-1 pl-3 type-body text-fg-2">
							{m.chat_footprintWhy()}
						</p>

						{#if footprint.hasActivity}
							<Collapsible.Root bind:open={methodOpen}>
								<Collapsible.Trigger>
									<RiArrowRightSLine class={methodOpen ? 'rotate-90' : ''} aria-hidden="true" /> {m.chat_howEstimated()}
								</Collapsible.Trigger>
								<Collapsible.Panel>
									<!-- Sources (for fact-check):
									     - CSCS lake-water cooling fact sheet:
									       https://www.cscs.ch/fileadmin/user_upload/contents_publications/factsheets/lake_water/20150630_Lake_water_cool_supercomputers_EN.pdf
									     - Per-token energy ballpark + CSCS hydro/carbon-neutral/waste-heat-reuse, and the
									       "Google median text prompt ~0.24 Wh" comparison: Xiaozhe Yao (SwissAI Serving),
									       https://about.yao.sh/posts/swissai-serving/ ("Energy Consumption" section). -->
									<div class="flex flex-col gap-5 pt-3" data-energy-method>
										<p class="type-caption text-fg-2">
											{m.chat_methodIntro()}
										</p>

										<!-- 1. What the number is made of — shares from the same constants as the estimate. -->
										<section class="flex flex-col gap-2" aria-labelledby="energy-parts">
											<h3 id="energy-parts" class="type-label text-fg-3">{m.chat_methodParts()}</h3>
											<div class="flex h-3 w-full overflow-hidden rounded-pill" role="img" aria-label={partsLabel}>
												{#each parts as part (part.key)}
													<span class="h-full bar-width {part.cls}" style:--bar-width="{part.share * 100}%"></span>
												{/each}
											</div>
											<ul class="flex flex-col gap-1.5">
												{#each parts as part (part.key)}
													<li class="flex items-start gap-2 type-caption">
														<span class="mt-1 size-2.5 shrink-0 rounded-sharp {part.cls}" aria-hidden="true"></span>
														<span class="flex-1 text-fg-2"><span class="text-fg-1">{part.label}</span> — {part.what}</span>
														<span class="shrink-0 text-fg-3 tabular-nums">{Math.round(part.share * 100)}%</span>
													</li>
												{/each}
											</ul>
										</section>

										<!-- 2. How sure we are — the plausible band on a log scale, the estimate marked. -->
										<section class="flex flex-col gap-2" aria-labelledby="energy-range">
											<h3 id="energy-range" class="type-label text-fg-3">{m.chat_methodRange()}</h3>
											<div class="relative h-3 w-full rounded-pill bg-tint-subtle" role="img" aria-label={m.chat_methodRangeLabel({ low: formatEnergy(band.lo), high: formatEnergy(band.hi), estimate: formatEnergy(footprint.energyWh) })}>
												<span class="absolute inset-y-0 bar-offset bar-width bg-accent-1/30 rounded-pill" style:--bar-offset="{rangePos.lo}%" style:--bar-width="{rangePos.hi - rangePos.lo}%"></span>
												<span class="absolute -inset-y-0.5 w-0.5 bar-offset bg-accent-1" style:--bar-offset="{rangePos.mid}%"></span>
											</div>
											<div class="flex justify-between type-caption text-fg-3 tabular-nums">
												<span>{formatEnergy(band.lo)}</span>
												<span class="text-fg-1">≈ {formatEnergy(footprint.energyWh)}</span>
												<span>{formatEnergy(band.hi)}</span>
											</div>
											<p class="type-caption text-fg-2">
												{m.chat_methodRangeNote({ spread })}
											</p>
										</section>

										<!-- 3. For scale -->
										<section class="flex flex-col gap-2" aria-labelledby="energy-scale">
											<h3 id="energy-scale" class="type-label text-fg-3">{m.chat_methodScale()}</h3>
											{#each scaleRows as row (row.label)}
												<div class="flex flex-col gap-1">
													<div class="flex justify-between type-caption">
														<span class="text-fg-2">{row.label}</span><span class="text-fg-1 tabular-nums">{formatEnergy(row.wh)}</span>
													</div>
													<div class="h-2 w-full rounded-pill bg-tint-subtle">
														<span class="block h-full bar-width rounded-pill {row.cls}" style:--bar-width="{Math.max(2, (row.wh / scaleMax) * 100)}%"></span>
													</div>
												</div>
											{/each}
										</section>

										<!-- 4. What's in, what's out -->
										<section class="grid grid-cols-2 gap-3" aria-label={m.chat_methodCountedLabel()}>
											<div class="flex flex-col gap-1.5">
												<h3 class="type-label text-fg-3">{m.chat_methodCounted()}</h3>
												{#each counted as item (item)}
													<p class="flex items-start gap-1.5 type-caption text-fg-2">
														<RiCheckLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-positive" />{item}
													</p>
												{/each}
											</div>
											<div class="flex flex-col gap-1.5">
												<h3 class="type-label text-fg-3">{m.chat_methodNotCounted()}</h3>
												{#each notCounted as item (item)}
													<p class="flex items-start gap-1.5 type-caption text-fg-2">
														<RiCloseLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-fg-3" />{item}
													</p>
												{/each}
											</div>
										</section>

										<p class="type-caption text-fg-3">
											{serving.namesSwitzerland ? m.chat_methodCalibrationSwiss() : m.chat_methodCalibration()}
										</p>
									</div>
								</Collapsible.Panel>
							</Collapsible.Root>
						{/if}
{/snippet}

<div class="flex w-fit max-w-full items-center gap-1.5" data-session-footprint>
	<!-- Phones: a bottom sheet with the shared header. Larger screens: a popover under the trigger. -->
	{#if phone.current}
		<Button
			variant="ghost"
			size={compact ? 'xs' : 'sm'}
			casing="sentence"
			aria-label={m.chat_footprintTrigger({ energy: energyShort, time: timeShort })}
			data-footprint-trigger
			onclick={() => (open = true)}
		>
			{@render triggerBody()}
		</Button>
		<Sheet.Root bind:open>
			<Sheet.Portal>
				<Sheet.Backdrop />
				<Sheet.Popup data-footprint-sheet>
					<Sheet.Header title={m.chat_thisSession()} />
					<Sheet.Body class="gap-5">{@render breakdown()}</Sheet.Body>
				</Sheet.Popup>
			</Sheet.Portal>
		</Sheet.Root>
	{:else}
		<Popover.Root bind:open>
			<Popover.Trigger
			variant="ghost"
			size={compact ? 'xs' : 'sm'}
			casing="sentence"
			aria-label={m.chat_footprintTrigger({ energy: energyShort, time: timeShort })}
			data-footprint-trigger
			>
				{@render triggerBody()}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner side="bottom" align="end">
					<!-- Don't auto-focus the first control: that's the "How is this estimated?" toggle at the
					     bottom, and focusing it scrolled the sheet to the end on open. Start at the top. -->
					<Popover.Popup
						size="lg"
						padded={false}
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							sheetEl?.scrollTo({ top: 0 });
							sheetEl?.focus({ preventScroll: true });
						}}
					>
						<div
							bind:this={sheetEl}
							tabindex="-1"
							class="scroll-fade-y flex max-h-112 flex-col gap-5 overflow-y-auto p-5 outline-none"
							data-footprint-sheet
						>
							{@render breakdown()}
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	{/if}

	{#if forget}
		<Button
			bind:ref={forgetBtnEl}
			variant="destructive"
			size={compact ? 'xs' : 'sm'}
			casing="sentence"
			onclick={openDeleteAll}
			aria-label={m.chat_forgetEverythingLabel()}
		>
			<RiDeleteBinFill aria-hidden="true" /> {m.chat_forgetEverything()}
		</Button>
	{/if}
</div>

<style>
	/* A changed figure rises into place; its icon glints in the accent. Once per change, never looped. */
	@media (prefers-reduced-motion: no-preference) {
		.footprint-roll {
			display: inline-block;
			animation: footprint-roll 360ms var(--ds-ease-standard) both;
		}
		.footprint-glint :global(svg) {
			animation: footprint-glint 1200ms var(--ds-ease-standard) both;
		}
		.footprint-note {
			animation: footprint-note 360ms var(--ds-ease-standard) both;
		}
		.footprint-tock :global(svg) {
			animation: footprint-tock 600ms var(--ds-ease-standard) both;
		}
	}
	@keyframes footprint-roll {
		from {
			opacity: 0;
			transform: translateY(45%);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes footprint-note {
		from {
			opacity: 0;
			transform: scale(0.85);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes footprint-glint {
		0% {
			transform: scale(1);
			filter: drop-shadow(0 0 0 transparent);
		}
		25% {
			transform: scale(1.25);
			filter: drop-shadow(0 0 4px var(--ds-accent-1));
		}
		100% {
			transform: scale(1);
			filter: drop-shadow(0 0 0 transparent);
		}
	}
	@keyframes footprint-tock {
		0% {
			transform: rotate(0deg);
		}
		40% {
			transform: rotate(30deg);
		}
		100% {
			transform: rotate(0deg);
		}
	}
</style>
