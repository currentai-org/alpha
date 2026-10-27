<script lang="ts">
	import { Button, Separator, Surface } from '@aipotluck/alpha-ds';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import PageHead from './PageHead.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Surfaces"
		lead="Three background tiers, one rule: Background 1 in the middle, recessed content goes darker (2), floating panels go lighter (3). A [data-surface] ancestor tells every part inside which tier it’s on."
	/>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Nesting</h2>
		<Surface level="1" border="auto" padding="lg" class="flex flex-col gap-4">
			<div class="flex items-center justify-between">
				<span class="type-label text-fg-3">Background 1 · page</span><Button size="sm"
					>One tier up = bg-2</Button
				>
			</div>
			<Surface level="2" border="auto" padding="lg" class="flex flex-col gap-4">
				<div class="flex items-center justify-between">
					<span class="type-label text-fg-3">Background 2 · inset (composer, cards)</span><Button
						size="sm">One tier up = bg-3</Button
					>
				</div>
				<Surface level="3" border="auto" padding="lg" class="flex flex-col gap-3">
					<div class="flex items-center justify-between">
						<span class="type-label text-fg-3">Background 3 · floating (XRAY, popovers)</span
						><Button size="sm">Steps back to bg-2</Button>
					</div>
					<Separator />
					<p class="type-caption text-fg-2">
						The rule above is Border 3 here — the same Separator renders Border 2 on the tiers
						outside.
					</p>
				</Surface>
			</Surface>
		</Surface>
	</section>
	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Contextual tokens</h2>
		<div class="overflow-x-auto border border-line-2">
			<table class="w-full text-left">
				<thead class="bg-surface-2 type-label text-fg-3"
					><tr
						><th class="px-3 py-2">data-surface</th><th class="px-3 py-2">--ds-surface</th><th
							class="px-3 py-2">--ds-surface-raised</th
						><th class="px-3 py-2">--ds-surface-line</th></tr
					></thead
				>
				<tbody class="type-code text-fg-2">
					<tr class="border-t border-line-1"
						><td class="px-3 py-2">1</td><td class="px-3 py-2">bg-1</td><td class="px-3 py-2"
							>bg-2</td
						><td class="px-3 py-2">line-2</td></tr
					>
					<tr class="border-t border-line-1"
						><td class="px-3 py-2">2</td><td class="px-3 py-2">bg-2</td><td class="px-3 py-2"
							>bg-3</td
						><td class="px-3 py-2">line-2</td></tr
					>
					<tr class="border-t border-line-1"
						><td class="px-3 py-2">3</td><td class="px-3 py-2">bg-3</td><td class="px-3 py-2"
							>bg-2</td
						><td class="px-3 py-2">line-3</td></tr
					>
					<tr class="border-t border-line-1"
						><td class="px-3 py-2">chrome</td><td class="px-3 py-2">bg-chrome</td><td
							class="px-3 py-2">bg-1</td
						><td class="px-3 py-2">line-2</td></tr
					>
				</tbody>
			</table>
		</div>
		<CodeBlock code={snippets.usage.code} html={snippets.usage.html} label={snippets.usage.label} />
	</section>
</div>
