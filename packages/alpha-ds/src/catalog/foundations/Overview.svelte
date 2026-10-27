<script lang="ts">
	import { resolve } from '$app/paths';
	import { Badge, Grid, Surface } from '@aipotluck/alpha-ds';
	import { ITEMS, LAYERS } from '../registry.ts';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();
	const count = (layer: string) => ITEMS.filter((i) => i.layer === layer).length;
	const baseUiCount = ITEMS.filter((i) => i.baseUi).length;

	const principles = [
		[
			'Tokens, not values',
			'Every colour, size and duration is a named token. A seed change re-derives the whole app in both modes; the linter stops raw values coming back.'
		],
		[
			'Base UI shape',
			`Components mirror Base UI part-for-part (${baseUiCount} mapped). An upgrade starts from the Base UI page linked on each entry.`
		],
		[
			'Brutalist by token',
			'Sharp corners, hard rules, flat surfaces, instant motion — encoded in scales.ts, not scattered through components.'
		],
		[
			'Surfaces decide',
			'Placement rules from the CF spec (one tier up, Border 3 on Background 3) resolve from the surface a part sits on.'
		]
	];
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<header class="flex flex-col items-start gap-4">
		<Badge>Foundation</Badge>
		<h1 class="type-display">Alpha design system</h1>
		<p class="type-subhead max-w-2xl font-normal text-fg-2">
			Tokens, Base UI–shaped components, layout primitives and page patterns for Alpha — brutalist
			in style, a sidebar-and-conversation desktop app in structure, OKLCH throughout.
		</p>
	</header>

	<Grid cols={4} ruled>
		{#each LAYERS as l, i (l.layer)}
			<div class="flex flex-col gap-2 p-5">
				<span class="type-label text-fg-3">0{i + 1}</span>
				<span class="type-title">{l.label}</span>
				<p class="type-caption text-fg-2">{l.blurb}</p>
				{#if l.layer !== 'foundation'}<span class="mt-auto type-code text-fg-3"
						>{count(l.layer)} items</span
					>{/if}
			</div>
		{/each}
	</Grid>

	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Principles</h2>
		<Grid cols={2} gap="4">
			{#each principles as [title, body] (title)}
				<Surface level="2" border="auto" padding="md" class="flex flex-col gap-2">
					<span class="type-title">{title}</span>
					<p class="type-caption text-fg-2">{body}</p>
				</Surface>
			{/each}
		</Grid>
	</section>

	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Start</h2>
		<CodeBlock
			code={snippets.quickstart.code}
			html={snippets.quickstart.html}
			label={snippets.quickstart.label}
		/>
		<CodeBlock code={snippets.tree.code} html={snippets.tree.html} label={snippets.tree.label} />
		<p class="type-body text-fg-2">
			To add a component: create <code class="type-code">components/&lt;name&gt;/</code> with its
			parts, a
			<code class="type-code">&lt;name&gt;.recipe.ts</code> skin,
			<code class="type-code">&lt;name&gt;.docs.ts</code>
			and one example — it appears here automatically. Full guide:
			<code class="type-code">packages/alpha-ds/src/README.md</code>. Next:
			<a
				class="underline decoration-line-3 underline-offset-4"
				href={resolve('/designsystem/[slug]', { slug: 'colors' })}>Color</a
			>.
		</p>
	</section>
</div>
