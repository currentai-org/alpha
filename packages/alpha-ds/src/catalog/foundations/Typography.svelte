<script lang="ts">
	import { fonts, textSizes, typeStyles } from '../../tokens/scales.ts';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import PageHead from './PageHead.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();
	const fontJobs: Record<string, string> = {
		sans: 'Font 1 — Plus Jakarta Sans. Everything by default.',
		mono: 'Font 2 — DM Mono. Technical/meta: labels, tags, panel titles, CTAs, nav.',
		serif: 'Font 3 — Noto Serif. Display headlines only.'
	};
	const roleClass: Record<string, string> = {
		label: 'type-label',
		nav: 'type-nav',
		cta: 'type-cta',
		caption: 'type-caption',
		body: 'type-body',
		title: 'type-title',
		heading: 'type-heading',
		display: 'type-display',
		code: 'type-code'
	};
	const sizeClass: Record<string, string> = {
		micro: 'text-micro',
		small: 'text-small',
		body: 'text-body',
		subhead: 'text-subhead',
		heading: 'text-heading',
		display: 'text-display'
	};
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Typography"
		lead="Three typefaces with one job each, six sizes, and named roles. Build emphasis from font + weight + text tier — never a seventh size."
	/>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Typefaces</h2>
		<div class="grid gap-px border border-line-2 bg-line-2 md:grid-cols-3">
			{#each Object.entries(fonts) as [key, stack] (key)}
				<div class="flex flex-col gap-3 bg-surface-1 p-5">
					<span
						class="text-heading {key === 'sans'
							? 'font-sans'
							: key === 'mono'
								? 'font-mono'
								: 'font-serif'}">Aa Gg 0123</span
					>
					<code class="type-code text-fg-1">--ds-font-{key}</code>
					<p class="type-caption text-fg-2">{fontJobs[key]}</p>
					<p class="font-mono text-micro text-fg-3">{stack}</p>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Size scale</h2>
		<div class="flex flex-col border border-line-2">
			{#each Object.entries(textSizes) as [key, s] (key)}
				<div class="flex items-baseline gap-6 border-b border-line-1 px-4 py-3 last:border-b-0">
					<code class="w-28 shrink-0 type-code text-fg-3">text-{key}</code>
					<span class="w-20 shrink-0 font-mono text-micro text-fg-3">{s.size} / {s.lineHeight}</span
					>
					<span class="truncate text-fg-1 {sizeClass[key]}">Your language. Your data.</span>
				</div>
			{/each}
		</div>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Type roles</h2>
		<div class="flex flex-col border border-line-2">
			{#each Object.entries(typeStyles) as [key, style] (key)}
				<div
					class="flex flex-col gap-2 border-b border-line-1 px-4 py-4 last:border-b-0 md:flex-row md:items-center"
				>
					<div class="flex shrink-0 flex-col gap-1 md:w-40">
						<code class="type-code text-fg-1">type-{key}</code>
						<span class="font-mono text-micro text-fg-3"
							>{style.font} · {style.size} · {style.weight}{'uppercase' in style
								? ' · upper'
								: ''}</span
						>
					</div>
					<span class="{roleClass[key]} text-fg-1">Open, public, non profit AI</span>
				</div>
			{/each}
		</div>
		<CodeBlock code={snippets.usage.code} html={snippets.usage.html} label={snippets.usage.label} />
	</section>
</div>
