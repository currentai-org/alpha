<script lang="ts">
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import { Badge, Collapsible, Grid, Toggle, ToggleGroup } from '@aipotluck/alpha-ds';
	import type { Bump } from '../../version/ledger.ts';
	import type { ChangelogData, ChangelogRelease } from '../../version/types.ts';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import SectionHeading from '../ui/SectionHeading.svelte';
	import PageHead from './PageHead.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets, changelog }: { snippets: HighlightedSnippets; changelog: ChangelogData } =
		$props();

	const BUMP_TONE = { major: 'destructive', minor: 'accent', patch: 'outline' } as const;
	const MEANING: Record<Bump, string> = {
		major: 'Removed or renamed a public name — code built on it must change.',
		minor: 'Added a public name — an export, part, prop, variant, token, utility, theme or rule.',
		patch: 'Changed look or behaviour with the same names.'
	};

	let filter = $state<'all' | Bump>('all');
	const expanded = $state<Record<string, boolean>>({});
	const shown = $derived(changelog.releases.filter((r) => filter === 'all' || r.bump === filter));

	/** `+2 props, −1 utility` — the one-line shape of a delta. */
	function deltaLine(r: ChangelogRelease): string {
		const tally = (lines: string[], sign: string) => {
			const by: Record<string, number> = {};
			for (const l of lines) by[l.split(' ')[0]] = (by[l.split(' ')[0]] ?? 0) + 1;
			return Object.entries(by).map(([k, n]) => `${sign}${n} ${k}${n === 1 ? '' : 's'}`);
		};
		return [...tally(r.added, '+'), ...tally(r.removed, '−')].join(', ');
	}
	const kindLine = (kinds: Record<string, number>) =>
		Object.entries(kinds)
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
			.join(' · ');
</script>

<div class="flex max-w-5xl flex-col gap-12 px-6 py-10 lg:px-12">
	<PageHead
		title="Changelog"
		lead="The version is derived from these entries, so there is no number to bump by hand. Each change adds one file; a check fails whenever the code's public names and the changelog disagree."
	/>

	<Grid cols={4} ruled>
		<div class="flex flex-col gap-2 p-5">
			<span class="type-label text-fg-3">Version</span>
			<span class="font-mono text-display text-fg-1">{changelog.version}</span>
			<span class="mt-auto type-code text-fg-3">{changelog.surfaceSize} public names</span>
		</div>
		{#each ['major', 'minor', 'patch'] as const as b (b)}
			<div class="flex flex-col gap-2 p-5">
				<span class="flex items-center gap-2 type-label text-fg-3"
					><Badge tone={BUMP_TONE[b]}>{b}</Badge> {changelog.counts[b]}</span
				>
				<p class="type-caption text-fg-2">{MEANING[b]}</p>
			</div>
		{/each}
	</Grid>

	<section class="flex flex-col gap-4">
		<SectionHeading id="how">How the number moves</SectionHeading>
		<p class="max-w-3xl type-body text-fg-2">
			<code class="type-code">major.minor.patch</code> counts the entries of each kind. Counting rather
			than resetting means two branches that each add an entry reach the same version whichever merges
			first, and the version only ever rises. Each entry's bump is checked against its surface block:
			an entry cannot call a removal a minor.
		</p>
		<CodeBlock
			code={snippets.record.code}
			html={snippets.record.html}
			label={snippets.record.label}
		/>
		<p class="max-w-3xl type-body text-fg-2">
			<code class="type-code">pnpm lint:design</code> (CI and pre-push) fails when a public name is
			added or removed without an entry, or when a branch changes design-system source — anything
			but docs, examples and specs — without adding one. The failure prints the exact command. The
			lint plugin carries this version as its
			<code class="type-code">meta.version</code>, so ESLint's cache drops results from an older
			rule.
		</p>
		<CodeBlock code={snippets.entry.code} html={snippets.entry.html} label={snippets.entry.label} />
	</section>

	<section class="flex flex-col gap-4">
		<SectionHeading id="releases">Releases</SectionHeading>
		<ToggleGroup
			bind:value={() => [filter], (v: string[]) => (filter = (v[0] as typeof filter) ?? filter)}
			aria-label="Filter by bump"
		>
			<Toggle value="all">All</Toggle>
			<Toggle value="major">Major</Toggle>
			<Toggle value="minor">Minor</Toggle>
			<Toggle value="patch">Patch</Toggle>
		</ToggleGroup>

		<ol class="flex flex-col border-t border-line-2">
			{#each shown as r (r.id)}
				<li
					id={`v${r.version}`}
					class="flex scroll-mt-24 flex-col gap-4 border-b border-line-2 py-5 sm:flex-row"
				>
					<div class="flex shrink-0 flex-row items-baseline gap-3 sm:w-32 sm:flex-col sm:gap-1">
						<a href={`#v${r.version}`} class="font-mono text-subhead text-fg-1 no-underline"
							>{r.version}</a
						>
						<time datetime={r.date} class="type-code text-fg-3">{r.date}</time>
					</div>
					<div class="flex min-w-0 flex-col items-start gap-2">
						<div class="flex flex-wrap items-center gap-2">
							<Badge tone={BUMP_TONE[r.bump]}>{r.bump}</Badge>
							{#if r.baseline}<Badge tone="solid">baseline</Badge>{/if}
						</div>
						<h3 class="type-title text-fg-1">{r.summary}</h3>
						{#if r.notesHtml}
							<div class="ds-changelog-notes max-w-3xl type-body text-fg-2">
								<!-- eslint-disable-next-line svelte/no-at-html-tags -- notes are our own checked-in markdown -->
								{@html r.notesHtml}
							</div>
						{/if}
						{#if r.baseline}
							<p class="type-caption text-fg-3">
								Surface snapshot every later entry is measured against: {kindLine(r.kinds)}.
							</p>
						{:else if r.added.length || r.removed.length}
							<Collapsible.Root bind:open={expanded[r.id]}>
								<Collapsible.Trigger>
									<RiArrowRightSLine class={expanded[r.id] ? 'rotate-90' : ''} />
									<span class="type-code">{deltaLine(r)}</span>
								</Collapsible.Trigger>
								<Collapsible.Panel>
									<ul class="flex flex-col py-2 pl-3 font-mono text-small" role="list">
										{#each r.removed as l (l)}<li class="text-accent-2-text">− {l}</li>{/each}
										{#each r.added as l (l)}<li class="text-positive-text">+ {l}</li>{/each}
									</ul>
								</Collapsible.Panel>
							</Collapsible.Root>
						{/if}
					</div>
				</li>
			{:else}
				<li class="py-5 type-caption text-fg-3">No {filter} entries yet.</li>
			{/each}
		</ol>
	</section>
</div>

<style>
	.ds-changelog-notes :global(p + p) {
		margin-top: var(--ds-space-2);
	}
	.ds-changelog-notes :global(code) {
		font-family: var(--ds-font-mono);
		font-size: 0.9em;
	}
	.ds-changelog-notes :global(ul) {
		list-style: square;
		padding-left: 1.25rem;
	}
</style>
