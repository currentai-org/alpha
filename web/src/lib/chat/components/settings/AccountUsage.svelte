<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { base } from '$lib/chat/paths';
	import { Meter } from '@aipotluck/alpha-ds';
	import type { AccountUsage } from '$lib/chat/server/accountUsage';
	import { wipeCommitted } from '$lib/chat/stores/deleteAll';
	import { getLocale } from '$lib/paraglide/runtime.js';

	// Settings → Data & privacy: the account's own usage (counts only — the endpoint never returns
	// message text) and the limits that apply to it. One series, so the chart carries no legend; the
	// heading names it. Every bar has a hover/focus tooltip and the numbers are also in a table.

	let usage = $state<AccountUsage | null>(null);
	let failed = $state(false);
	let hover = $state<number | null>(null);

	async function load() {
		try {
			const res = await fetch(`${base}/api/v2/user/usage`);
			if (!res.ok) throw new Error(String(res.status));
			usage = await res.json();
			failed = false;
		} catch {
			failed = true;
		}
	}

	onMount(load);

	// "Forget everything" runs from this page and its receipt opens over it. Without a reload the panel
	// behind the receipt kept the pre-wipe counts, so the page contradicted the receipt (CUR-2666).
	// wipeCommitted turns true once the server has confirmed the delete.
	$effect(() => {
		if ($wipeCommitted) load();
	});

	const nf = $derived(new Intl.NumberFormat(getLocale()));
	const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
		new Date(`${iso}T00:00:00Z`).toLocaleDateString(getLocale(), { ...opts, timeZone: 'UTC' });

	// Chart geometry (viewBox units; the SVG scales to its container width).
	const W = 600;
	const H = 140;
	const PAD_TOP = 8;
	const GAP = 2;

	const days = $derived(usage?.daily ?? []);
	const peak = $derived(Math.max(1, ...days.map((d) => d.messages)));
	// A round-ish gridline at the top so the scale is readable without an axis of numbers.
	const scaleMax = $derived.by(() => {
		const step = peak <= 5 ? 1 : peak <= 20 ? 5 : peak <= 100 ? 25 : 10 ** Math.floor(Math.log10(peak));
		return Math.ceil(peak / step) * step;
	});
	const barW = $derived(days.length ? W / days.length - GAP : 0);
	const windowTotal = $derived(days.reduce((s, d) => s + d.messages, 0));
	const activeDays = $derived(days.filter((d) => d.messages > 0).length);

	type LimitRow = { label: string; value: number; max: number; unit: string; note: string };
	const limitRows = $derived.by((): LimitRow[] => {
		if (!usage) return [];
		const { limits, totals, longestConversation } = usage;
		const rows: LimitRow[] = [];
		if (limits.conversations)
			rows.push({
				label: m.usage_conversations(),
				value: totals.conversations,
				max: limits.conversations,
				unit: '',
				note: m.usage_conversationsNote()
			});
		if (limits.messagesPerConversation)
			rows.push({
				label: m.usage_longestConversation(),
				value: longestConversation,
				max: limits.messagesPerConversation,
				unit: ` ${m.usage_messagesUnit()}`,
				note: m.usage_longestConversationNote()
			});
		return rows;
	});
</script>

<section class="flex flex-col gap-4" aria-labelledby="usage-heading" data-account-usage>
	<div class="flex flex-col gap-1">
		<h2 id="usage-heading" class="type-label text-fg-1">{m.usage_title()}</h2>
		<p class="type-caption text-fg-3">{m.usage_help()}</p>
	</div>

	{#if failed}
		<p class="type-body text-fg-3">{m.usage_failed()}</p>
	{:else if !usage}
		<div class="h-64 animate-pulse bg-surface-2 rounded-card" aria-hidden="true"></div>
	{:else}
		<!-- Headline numbers -->
		<dl class="grid grid-cols-2 gap-px overflow-hidden border border-line-2 bg-line-2 rounded-card sm:grid-cols-4">
			{#each [[m.usage_conversations(), usage.totals.conversations], [m.usage_messagesSent(), usage.totals.userMessages], [m.usage_totalMessages(), usage.totals.messages], [m.usage_charactersTyped(), usage.totals.characters]] as [label, value] (label)}
				<div class="flex flex-col gap-1 bg-surface-1 p-3">
					<dt class="type-caption text-fg-3">{label}</dt>
					<dd class="type-nav tabular-nums text-fg-1">{nf.format(Number(value))}</dd>
				</div>
			{/each}
		</dl>

		<!-- Messages sent per day -->
		<figure class="flex flex-col gap-2 border border-line-2 p-4 rounded-card">
			<figcaption class="flex flex-wrap items-baseline justify-between gap-2">
				<span class="type-label text-fg-1">{m.usage_chartTitle({ days: days.length })}</span>
				<span class="type-caption text-fg-3 tabular-nums">
					{m.usage_chartSummary({ total: nf.format(windowTotal), active: activeDays, days: days.length })}
				</span>
			</figcaption>

			<div class="relative">
				<svg
					viewBox="0 0 {W} {H}"
					preserveAspectRatio="none"
					class="block h-36 w-full overflow-visible"
					role="img"
					aria-label={m.usage_chartAria({ total: nf.format(windowTotal), days: days.length, peak: nf.format(peak === 1 && windowTotal === 0 ? 0 : peak) })}
					onpointerleave={() => (hover = null)}
				>
					<!-- recessive gridlines: baseline, midpoint, top -->
					{#each [0, 0.5, 1] as f (f)}
						<line
							x1="0"
							x2={W}
							y1={H - f * (H - PAD_TOP)}
							y2={H - f * (H - PAD_TOP)}
							class="stroke-line-2"
							stroke-width="1"
							vector-effect="non-scaling-stroke"
							stroke-dasharray={f === 0 ? undefined : '2 3'}
						/>
					{/each}
					{#each days as d, i (d.date)}
						{@const h = (d.messages / scaleMax) * (H - PAD_TOP)}
						{@const x = i * (barW + GAP) + GAP / 2}
						<!-- full-height hit target, bigger than the mark -->
						<rect
							{x}
							y="0"
							width={barW + GAP}
							height={H}
							fill="transparent"
							onpointerenter={() => (hover = i)}
							role="presentation"
						/>
						{#if d.messages > 0}
							<rect
								{x}
								y={H - Math.max(h, 2)}
								width={barW}
								height={Math.max(h, 2)}
								rx="2"
								class={hover === null || hover === i ? 'fill-accent-1' : 'fill-accent-1 opacity-40'}
								pointer-events="none"
							/>
						{/if}
					{/each}
				</svg>

				<span class="pointer-events-none absolute -top-1 right-0 type-caption text-fg-3 tabular-nums"
					>{nf.format(scaleMax)}</span
				>

				{#if hover !== null && days[hover]}
					{@const d = days[hover]}
					<div
						class="usage-tip pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full bg-surface-1 px-2 py-1 whitespace-nowrap shadow-popover rounded-field"
						style:--tip-x="{((hover + 0.5) / days.length) * 100}%"
						role="tooltip"
					>
						<div class="type-caption text-fg-3">{dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
						<div class="type-label text-fg-1 tabular-nums">
							{d.messages === 1 ? m.usage_oneMessage() : m.usage_nMessages({ count: nf.format(d.messages) })}
						</div>
					</div>
				{/if}
			</div>

			<div class="flex justify-between type-caption text-fg-3">
				<span>{dayLabel(days[0].date)}</span>
				<span>{m.usage_today()}</span>
			</div>

			<details class="type-caption text-fg-3">
				<summary class="cursor-pointer hover:text-fg-2">{m.usage_showTable()}</summary>
				<table class="mt-2 w-full tabular-nums">
					<thead>
						<tr class="text-left"><th class="font-normal">{m.usage_day()}</th><th class="text-right font-normal">{m.usage_messages()}</th></tr>
					</thead>
					<tbody class="text-fg-2">
						{#each days as d (d.date)}
							<tr><td>{dayLabel(d.date)}</td><td class="text-right">{d.messages}</td></tr>
						{/each}
					</tbody>
				</table>
			</details>
		</figure>

		<!-- Limits -->
		<div class="flex flex-col gap-3 border border-line-2 p-4 rounded-card">
			<h3 class="type-label text-fg-1">{m.usage_limits()}</h3>
			{#each limitRows as row (row.label)}
				{@const ratio = row.value / row.max}
				<Meter.Root value={Math.min(row.value, row.max)} max={row.max} format={() => m.usage_ofMax({ value: nf.format(row.value), max: `${nf.format(row.max)}${row.unit}` })}>
					<Meter.Label>{row.label}</Meter.Label>
					<Meter.Value />
					<Meter.Track><Meter.Indicator tone={ratio >= 0.8 ? 'default' : 'accent'} /></Meter.Track>
				</Meter.Root>
				{#if ratio >= 0.8}<p class="-mt-1 type-caption text-fg-2">{row.note}</p>{/if}
			{/each}

			<ul class="flex flex-col divide-y divide-line-2 type-body">
				{#if usage.limits.messagesPerMinute}
					<li class="flex justify-between gap-4 py-2">
						<span class="text-fg-2">{m.usage_messagesPerMinute()}</span>
						<span class="text-fg-1 tabular-nums">{nf.format(usage.limits.messagesPerMinute)}</span>
					</li>
				{/if}
				{#if usage.limits.messageLength}
					<li class="flex justify-between gap-4 py-2">
						<span class="text-fg-2">{m.usage_longestMessage()}</span>
						<span class="text-fg-1 tabular-nums">{m.usage_nCharacters({ count: nf.format(usage.limits.messageLength) })}</span>
					</li>
				{/if}
				{#if usage.limits.retentionDays}
					<li class="flex justify-between gap-4 py-2">
						<span class="text-fg-2">{m.usage_guestKeptFor()}</span>
						<span class="text-fg-1 tabular-nums">{m.usage_nDays({ count: usage.limits.retentionDays })}</span>
					</li>
				{/if}
			</ul>

			{#if !limitRows.length && !usage.limits.messagesPerMinute && !usage.limits.messageLength && !usage.limits.retentionDays}
				<p class="type-body text-fg-2">{m.usage_noLimits()}</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	/* The hovered day's tooltip follows its bar: a runtime value, fed in as a custom property. */
	.usage-tip {
		left: var(--tip-x);
	}
</style>
