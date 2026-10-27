<!--
  Theme playground. Seeds in, the whole semantic ladder out — computed by the same deriveTheme()
  the generator uses, applied as ThemeProvider overrides to a live preview. Nothing here writes
  files; "Export" produces the seed object to paste into tokens/themes.ts.
-->
<script lang="ts">
	import {
		Badge,
		Button,
		Composer,
		EmptyState,
		EmptyStateSuggestion,
		Message,
		Slider,
		Stack,
		ThemeProvider,
		Toggle,
		ToggleGroup,
		getThemeContext,
		type ColorMode
	} from '@aipotluck/alpha-ds';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import { themeDeclarations } from '../../tokens/build.ts';
	import { CONTRAST_TARGETS, deriveMode } from '../../tokens/color/derive.ts';
	import { contrast } from '../../tokens/color/oklch.ts';
	import { getTheme, type ThemeSeeds } from '../../tokens/themes.ts';
	import CodeBlock from '../ui/CodeBlock.svelte';
	import PageHead from './PageHead.svelte';
	import type { HighlightedSnippets } from './types.ts';

	let { snippets }: { snippets: HighlightedSnippets } = $props();
	const ctx = getThemeContext();

	const clone = (t: ThemeSeeds): ThemeSeeds => JSON.parse(JSON.stringify(t));
	let seeds = $state<ThemeSeeds>(clone(getTheme(ctx?.theme ?? 'alpha')));
	let previewMode = $state<ColorMode>('dark');
	let editing = $state<'light' | 'dark'>('dark');

	const overrides = $derived(themeDeclarations(seeds));
	const checks = $derived(
		(['light', 'dark'] as const).flatMap((mode) => {
			const p = deriveMode(seeds, mode);
			const on = [p['bg-1'], p['bg-2'], p['bg-3']];
			const min = (k: string, bgs = on) => Math.min(...bgs.map((b) => contrast(p[k], b)));
			return [
				{ mode, name: 'Text 1', ratio: min('fg-1'), target: CONTRAST_TARGETS['fg-1'] },
				{ mode, name: 'Text 2', ratio: min('fg-2'), target: CONTRAST_TARGETS['fg-2'] },
				{
					mode,
					name: 'Text 3 (bg 1–2)',
					ratio: min('fg-3', on.slice(0, 2)),
					target: CONTRAST_TARGETS['fg-3']
				},
				{
					mode,
					name: 'Accent text',
					ratio: min('accent-1-text'),
					target: CONTRAST_TARGETS['accent-text']
				},
				{
					mode,
					name: 'Glyph on accent',
					ratio: contrast(p['fg-on-accent'], p['accent-1']),
					target: CONTRAST_TARGETS['on-accent']
				}
			];
		})
	);
	const exported = $derived(
		`export const myTheme: ThemeSeeds = ${JSON.stringify(seeds, null, '\t')
			.replace(/"([a-z]+)":/gi, '$1:')
			.replace(/"/g, "'")};`
	);

	function reset(id: string) {
		seeds = clone(getTheme(id));
	}
</script>

{#snippet color(label: string, get: () => string, set: (v: string) => void)}
	<label class="flex items-center justify-between gap-3 type-caption text-fg-2">
		{label}
		<span class="flex items-center gap-2">
			<code class="type-code text-fg-3">{get()}</code>
			<input
				type="color"
				value={get().slice(0, 7)}
				oninput={(e) => set(e.currentTarget.value)}
				class="size-7 cursor-pointer border border-line-2 bg-transparent p-0.5"
			/>
		</span>
	</label>
{/snippet}

{#snippet range(
	label: string,
	get: () => number,
	set: (v: number) => void,
	min: number,
	max: number,
	step: number
)}
	<div class="flex flex-col gap-1">
		<div class="flex justify-between type-caption text-fg-2">
			<span>{label}</span><code class="type-code text-fg-3">{get().toFixed(3)}</code>
		</div>
		<Slider.Root bind:value={get, set} {min} {max} {step} aria-label={label}>
			<Slider.Control
				><Slider.Track><Slider.Indicator /><Slider.Thumb /></Slider.Track></Slider.Control
			>
		</Slider.Root>
	</div>
{/snippet}

<div class="flex max-w-6xl flex-col gap-10 px-6 py-10 lg:px-12">
	<PageHead
		title="Theming"
		lead="A theme is a dozen seeds, not a palette. The engine derives both modes — surface tiers by OKLCH lightness, text tiers solved to WCAG targets, rule and tint ladders — so no seed change can ship unreadable text."
	/>

	<div class="flex flex-col gap-6 lg:flex-row lg:items-start">
		<aside
			class="flex shrink-0 flex-col gap-5 border border-line-2 bg-surface-2 p-4 lg:w-80"
			data-surface="2"
		>
			<div class="flex items-center justify-between">
				<span class="type-label text-fg-3">Seeds</span>
				<div class="flex gap-1">
					<Button size="xs" onclick={() => reset('alpha')}>Alpha</Button>
					<Button size="xs" onclick={() => reset('paper')}>Paper</Button>
				</div>
			</div>
			<Stack gap="2">
				{@render color(
					'Accent 1',
					() => seeds.accent,
					(v) => (seeds.accent = v)
				)}
				{@render color(
					'Accent 2 · destructive',
					() => seeds.destructive,
					(v) => (seeds.destructive = v)
				)}
				{@render color(
					'Positive',
					() => seeds.positive,
					(v) => (seeds.positive = v)
				)}
				{@render color(
					'Caution',
					() => seeds.caution,
					(v) => (seeds.caution = v)
				)}
			</Stack>
			<ToggleGroup
				bind:value={
					() => [editing], (v: string[]) => (editing = (v[0] as 'light' | 'dark') ?? editing)
				}
				aria-label="Edit mode seeds"
			>
				<Toggle value="light">Light seeds</Toggle>
				<Toggle value="dark">Dark seeds</Toggle>
			</ToggleGroup>
			<Stack gap="3">
				{@render color(
					'Background 1',
					() => seeds[editing].background,
					(v) => (seeds[editing].background = v)
				)}
				{@render color(
					'Text 1',
					() => seeds[editing].foreground,
					(v) => (seeds[editing].foreground = v)
				)}
				{@render color(
					'Chrome',
					() => seeds[editing].chrome,
					(v) => (seeds[editing].chrome = v)
				)}
				{@render range(
					'Inset (bg-2 ΔL)',
					() => seeds[editing].inset,
					(v) => (seeds[editing].inset = v),
					-0.12,
					0,
					0.002
				)}
				{@render range(
					'Raised (bg-3 ΔL)',
					() => seeds[editing].raised,
					(v) => (seeds[editing].raised = v),
					0,
					0.2,
					0.002
				)}
				{@render range(
					'Border 2 opacity',
					() => seeds[editing].lines[1],
					(v) => (seeds[editing].lines = [seeds[editing].lines[0], v, seeds[editing].lines[2]]),
					0.05,
					0.6,
					0.01
				)}
			</Stack>
		</aside>

		<div class="flex min-w-0 flex-1 flex-col gap-4">
			<div class="flex items-center justify-between">
				<span class="type-label text-fg-3">Preview</span>
				<ToggleGroup
					bind:value={
						() => [previewMode], (v: string[]) => (previewMode = (v[0] as ColorMode) ?? previewMode)
					}
					aria-label="Preview mode"
				>
					<Toggle value="light">Light</Toggle>
					<Toggle value="dark">Dark</Toggle>
				</ToggleGroup>
			</div>
			<ThemeProvider mode={previewMode} {overrides} class="border-2 border-line-strong">
				<div class="flex flex-col gap-6 p-6">
					<EmptyState
						title="What do you want to know?"
						description="Answers name the model that served them."
					>
						<Composer.Root value="Which open models speak Swahili?">
							<Composer.Input />
							<Composer.Toolbar
								><Composer.Tools><Toggle pressed>Web search</Toggle></Composer.Tools><Composer.Send
								/></Composer.Toolbar
							>
						</Composer.Root>
						{#snippet suggestions()}<EmptyStateSuggestion
								>Map the open speech stack</EmptyStateSuggestion
							>{/snippet}
					</EmptyState>
					<div class="mx-auto flex w-full max-w-thread flex-col gap-4 px-4">
						<Message.Root from="user"
							><Message.Content>Where does it run?</Message.Content></Message.Root
						>
						<Message.Root from="assistant">
							<Message.Content
								>On public-interest compute. <span class="text-accent-1-text"
									>Open the XRAY view</span
								> to see the stack.</Message.Content
							>
							<Message.Meta
								><Badge>Apertus</Badge><Badge tone="positive">Live</Badge> Text 3 meta line</Message.Meta
							>
						</Message.Root>
						<div class="flex flex-wrap gap-2">
							<Button variant="primary">Primary</Button><Button>Secondary</Button><Button
								variant="destructive"><RiDeleteBinFill /> Forget</Button
							>
						</div>
					</div>
				</div>
			</ThemeProvider>
			<div class="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2">
				{#each checks as c (c.mode + c.name)}
					<div class="flex items-center justify-between bg-surface-1 px-3 py-2">
						<span class="type-caption text-fg-2"
							><span class="type-label text-fg-3">{c.mode}</span> {c.name}</span
						>
						<Badge tone={c.ratio >= c.target ? 'positive' : 'destructive'}
							>{c.ratio.toFixed(2)} / {c.target}</Badge
						>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<section class="flex flex-col gap-4">
		<h2 class="border-b border-line-2 pb-2 type-heading">Ship it</h2>
		<p class="type-body text-fg-2">
			Paste into <code class="type-code">packages/alpha-ds/src/tokens/themes.ts</code> (add to
			<code class="type-code">themes</code>, or replace <code class="type-code">alphaTheme</code>),
			then regenerate. The contrast contract in <code class="type-code">tokens.spec.ts</code> runs against
			every shipped theme.
		</p>
		<CodeBlock code={exported} label="themes.ts" collapsible />
		<CodeBlock
			code={snippets.regenerate.code}
			html={snippets.regenerate.html}
			label={snippets.regenerate.label}
		/>
		<CodeBlock
			code={snippets.provider.code}
			html={snippets.provider.html}
			label={snippets.provider.label}
		/>
	</section>
</div>
