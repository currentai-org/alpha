<!--
  Colour foundation. Every swatch paints with the LIVE token (so it follows the header's theme +
  mode), and lists both modes' OKLCH values and WCAG contrast computed by the same engine that
  generated them.
-->
<script lang="ts">
	import { Badge, getThemeContext } from '@aipotluck/alpha-ds';
	import {
		CONTRAST_TARGETS,
		deriveMode,
		SEMANTIC_TOKENS,
		type SemanticToken
	} from '../../tokens/color/derive.ts';
	import { contrast, formatOklch } from '../../tokens/color/oklch.ts';
	import { getTheme } from '../../tokens/themes.ts';
	import { TAILWIND_COLORS } from '../../tokens/tailwind-map.ts';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();
	const ctx = getThemeContext();
	const seeds = $derived(getTheme(ctx?.theme ?? 'alpha'));
	const light = $derived(deriveMode(seeds, 'light'));
	const dark = $derived(deriveMode(seeds, 'dark'));

	const groups: { id: SemanticToken['group']; label: string; blurb: string }[] = [
		{
			id: 'surface',
			label: 'Surfaces',
			blurb: 'Three tones by elevation — darker sinks, lighter floats. Plus chrome and inverse.'
		},
		{
			id: 'text',
			label: 'Text',
			blurb: 'One ink, three strengths. Text 3 is solved to AA so it can carry real copy.'
		},
		{
			id: 'line',
			label: 'Rules',
			blurb: 'One ink at three opacities; the surface underneath picks the weight.'
		},
		{
			id: 'accent',
			label: 'Accents',
			blurb:
				'Accent 1 = the one primary action, Accent 2 = destructive. Icon/badge scale only — never a surface.'
		},
		{
			id: 'status',
			label: 'Status',
			blurb: 'Source-freshness / health marks, with text-safe variants.'
		},
		{ id: 'tint', label: 'Tints', blurb: 'Ink washes layered over a fill for hover and active.' },
		{ id: 'utility', label: 'Utility', blurb: 'Focus ring, scrim, selection, decorative grid.' }
	];
	const utilityFor = (name: string) =>
		Object.entries(TAILWIND_COLORS).find(([, t]) => t === name)?.[0];
	const isText = (g: string, n: string) => g === 'text' || n.endsWith('-text');
	const ratioOn = (name: string, mode: 'light' | 'dark') => {
		const p = mode === 'light' ? light : dark;
		const bg =
			name === 'fg-on-chrome'
				? p['bg-chrome']
				: name === 'fg-inverse'
					? p['bg-inverse']
					: name === 'fg-on-accent'
						? p['accent-1']
						: p['bg-1'];
		return contrast(p[name], bg);
	};
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<header class="flex flex-col items-start gap-4">
		<Badge>Foundation</Badge>
		<h1 class="type-display">Color</h1>
		<p class="type-subhead max-w-2xl font-normal text-fg-2">
			Semantic OKLCH tokens derived from a dozen seeds per theme. Each is a single
			<code class="type-code">light-dark()</code> declaration, so mode switching is just
			<code class="type-code">color-scheme</code>. Text contrast is solved, not hoped for — targets:
			Text 1 ≥ {CONTRAST_TARGETS['fg-1']}:1, Text 2/3 ≥ {CONTRAST_TARGETS['fg-2']}:1.
		</p>
	</header>

	<CodeBlock code={snippets.usage.code} html={snippets.usage.html} label={snippets.usage.label} />

	{#each groups as group (group.id)}
		<section class="flex flex-col gap-4">
			<div>
				<h2 class="border-b border-line-2 pb-2 type-heading">{group.label}</h2>
				<p class="mt-2 type-caption text-fg-2">{group.blurb}</p>
			</div>
			<div class="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2">
				{#each SEMANTIC_TOKENS.filter((t) => t.group === group.id) as token (token.name)}
					<div class="flex gap-3 bg-surface-1 p-3">
						<div class="grid size-14 shrink-0 grid-cols-2 border border-line-2">
							<div data-mode="light" class="bg-surface-1">
								<span class="ds-swatch" style:--swatch="var(--ds-{token.name})"></span>
							</div>
							<div data-mode="dark" class="bg-surface-1">
								<span class="ds-swatch" style:--swatch="var(--ds-{token.name})"></span>
							</div>
						</div>
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							<div class="flex flex-wrap items-baseline gap-2">
								<code class="type-code text-fg-1">--ds-{token.name}</code>
								{#if utilityFor(token.name)}<code class="type-code text-fg-3"
										>*-{utilityFor(token.name)}</code
									>{/if}
							</div>
							<p class="type-caption text-fg-2">{token.description}</p>
							<p class="font-mono text-micro text-fg-3">
								L {formatOklch(light[token.name])}<br />D {formatOklch(dark[token.name])}
							</p>
							{#if isText(group.id, token.name)}
								<div class="flex gap-1.5">
									{#each ['light', 'dark'] as const as m (m)}
										{@const r = ratioOn(token.name, m)}
										<Badge tone={r >= 4.5 ? 'positive' : r >= 3 ? 'caution' : 'destructive'}
											>{m[0]} {r.toFixed(1)}:1</Badge
										>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/each}
				{#if SEMANTIC_TOKENS.filter((t) => t.group === group.id).length % 2}
					<div class="bg-surface-1 max-sm:hidden" aria-hidden="true"></div>
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	.ds-swatch {
		display: block;
		width: 100%;
		height: 100%;
		background: var(--swatch);
	}
</style>
