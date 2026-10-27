<script lang="ts">
	import { Badge } from '@aipotluck/alpha-ds';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import PageHead from './PageHead.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();

	const rules = [
		{
			name: 'no-raw-colors',
			what: 'Palette classes and colour literals instead of tokens.',
			bad: 'bg-gray-800 · text-[#fff] · color: rgb(…)',
			good: 'bg-surface-2 · text-fg-1 · var(--ds-fg-1)',
			shadcn: true
		},
		{
			name: 'no-arbitrary-values',
			what: 'Arbitrary Tailwind values that bypass the scales.',
			bad: 'p-[13px] · text-[15px] · rounded-[6px]',
			good: 'p-3 · text-body · rounded-field',
			shadcn: true
		},
		{
			name: 'no-inline-styles',
			what: 'style="" / style: that set visual properties. Custom-property assignments (style:--x) are allowed.',
			bad: 'style="color: red"',
			good: 'class="text-accent-2-text"',
			shadcn: true
		},
		{
			name: 'no-restyle',
			what: 'Visual classes passed to a design-system component. Layout (margin, flex, width, grid) is fine; colour, radius, type belong to the recipe.',
			bad: '<Button class="bg-red-500 rounded-full">',
			good: '<Button variant="destructive" class="ml-auto">',
			shadcn: true
		},
		{
			name: 'require-static-classes',
			what: 'Interpolated class names the scanner and linter cannot see.',
			bad: 'class="bg-{tone}-500"',
			good: "class={tone === 'x' ? 'bg-accent-1' : 'bg-surface-2'}",
			shadcn: true
		},
		{
			name: 'no-legacy-tokens',
			what: 'Pre-system variables (--ap-*, --paper, --salmon…). Ratcheted: the count may only go down.',
			// eslint-disable-next-line alpha-ds/no-legacy-tokens -- documents the violation this rule reports
			bad: 'var(--ap-ink-3)',
			good: 'var(--ds-fg-3) / text-fg-3',
			shadcn: false
		},
		{
			name: 'no-unknown-tokens',
			what: 'var(--ds-*) names that are not in the generated token manifest (typos, removed tokens).',
			// eslint-disable-next-line alpha-ds/no-unknown-tokens -- documents the violation this rule reports
			bad: 'var(--ds-fg-4)',
			good: 'var(--ds-fg-3)',
			shadcn: false
		},
		{
			name: 'pill-nested-radius',
			what: 'A button inside a rounded-pill container that keeps a smaller radius, so its hover tile shows square corners against the curve. Autofixes to shape="pill".',
			bad: '<div class="rounded-pill"><Button size="icon-xs">',
			good: '<div class="rounded-pill"><Button shape="pill" size="icon-xs">',
			shadcn: false
		},
		{
			name: 'remix-icons-only',
			what: 'Icons from any set other than Remix (spec §5).',
			bad: "import X from '~icons/lucide/x'",
			good: "import X from '~icons/ri/close-line'",
			shadcn: false
		}
	];
</script>

<div class="flex max-w-5xl flex-col gap-10 px-6 py-10 lg:px-12">
	<PageHead
		title="Design lint"
		lead="An ESLint plugin (alpha-ds/*) modelled on shadcn/lint, plus rules for this system’s own contracts. Errors inside the design system and migrated surfaces; a ratchet everywhere else so legacy debt can only shrink."
	/>
	<CodeBlock code={snippets.run.code} html={snippets.run.html} label={snippets.run.label} />
	<div class="flex flex-col border border-line-2">
		{#each rules as r (r.name)}
			<div class="flex flex-col gap-3 border-b border-line-1 p-4 last:border-b-0 md:flex-row">
				<div class="flex shrink-0 flex-col items-start gap-2 md:w-56">
					<code class="type-code text-fg-1">alpha-ds/{r.name}</code>
					{#if r.shadcn}<Badge>shadcn/lint parity</Badge>{:else}<Badge tone="accent">Alpha</Badge
						>{/if}
				</div>
				<div class="flex min-w-0 flex-1 flex-col gap-2">
					<p class="type-body text-fg-2">{r.what}</p>
					<div class="grid gap-2 sm:grid-cols-2">
						<p class="border-l-2 border-accent-2 pl-2 font-mono text-micro text-fg-2">
							<span class="text-accent-2-text">✗</span>
							{r.bad}
						</p>
						<p class="border-l-2 border-positive pl-2 font-mono text-micro text-fg-2">
							<span class="text-positive-text">✓</span>
							{r.good}
						</p>
					</div>
				</div>
			</div>
		{/each}
	</div>
</div>
