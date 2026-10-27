<!--
  @component
  One catalog entry, laid out like base-ui.com/react/components/accordion:
  title + summary → hero demo → anatomy → examples → API reference (per part: props, data
  attributes, CSS variables) → guidelines. Right rail: on-this-page.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import RiExternalLinkLine from '~icons/ri/external-link-line';
	import { Badge, Inline } from '@aipotluck/alpha-ds';
	import type { CatalogItem } from '../registry.ts';
	import ApiTable from './ApiTable.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import DemoBlock from './DemoBlock.svelte';
	import SectionHeading from './SectionHeading.svelte';
	import Toc from './Toc.svelte';

	let {
		item,
		examples,
		anatomyHtml,
		importHtml
	}: {
		item: CatalogItem;
		examples: { file: string; code: string; html?: string; component?: Component }[];
		anatomyHtml?: string;
		importHtml?: string;
	} = $props();

	const partId = (name: string) => 'api-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const [hero, ...rest] = $derived(examples);
	const importCode = $derived(`import { ${exportName(item)} } from '@aipotluck/alpha-ds';`);
	const layerLabel = {
		component: 'Component',
		primitive: 'Primitive',
		pattern: 'Pattern',
		foundation: 'Foundation'
	};

	/** Every distinct root the parts hang off (`Accordion`, `RadioGroup` + `Radio`, `useToastManager`). */
	function exportName(i: CatalogItem): string {
		const roots = (i.parts ?? [])
			.map((p) => p.name.split(/[.\s(]/)[0])
			.filter((r) => /^[A-Za-z]+$/.test(r));
		const unique = [...new Set(roots)];
		return unique.length ? unique.join(', ') : i.name.replace(/\s/g, '');
	}

	const toc = $derived([
		...(item.anatomy ? [{ id: 'anatomy', label: 'Anatomy' }] : []),
		...(rest.length ? [{ id: 'examples', label: 'Examples' }] : []),
		...rest.map((e) => ({
			id: `example-${e.file}`,
			label: item.examples.find((x) => x.file === e.file)?.title ?? e.file,
			depth: 1
		})),
		...(item.parts?.length ? [{ id: 'api', label: 'API reference' }] : []),
		...(item.parts ?? []).map((p) => ({ id: partId(p.name), label: p.name, depth: 1 })),
		...(item.guidelines ? [{ id: 'guidelines', label: 'Guidelines' }] : [])
	]);
</script>

<div class="flex gap-12 px-6 py-10 lg:px-12">
	<article class="flex max-w-4xl min-w-0 flex-1 flex-col gap-12">
		<header class="flex flex-col gap-4">
			<Inline gap="2">
				<Badge>{layerLabel[item.layer]}</Badge>
				{#if item.baseUi}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external base-ui.com link -->
					<a
						href={item.baseUi.url}
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-1 type-label text-fg-3 hover:text-fg-1"
					>
						Base UI · {item.baseUi.name}
						<RiExternalLinkLine class="size-3" aria-hidden="true" />
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else if item.layer === 'component'}
					<Badge tone="caution">Alpha addition</Badge>
				{/if}
			</Inline>
			<h1 class="type-display text-fg-1">{item.name}</h1>
			<p class="type-subhead max-w-2xl font-normal text-fg-2">{item.description}</p>
		</header>

		{#if hero}
			<DemoBlock
				id="example-{hero.file}"
				component={hero.component}
				code={hero.code}
				html={hero.html}
			/>
		{/if}

		<CodeBlock code={importCode} html={importHtml} label="Import" />

		{#if item.anatomy}
			<section class="flex flex-col gap-4">
				<SectionHeading id="anatomy">Anatomy</SectionHeading>
				<p class="type-body text-fg-2">
					Import the parts and assemble them. Part names match Base UI one-to-one{item.baseUi
						? ''
						: ' where an equivalent exists'}.
				</p>
				<CodeBlock code={item.anatomy} html={anatomyHtml} label="Anatomy" />
			</section>
		{/if}

		{#if rest.length}
			<section class="flex flex-col gap-8">
				<SectionHeading id="examples">Examples</SectionHeading>
				{#each rest as ex (ex.file)}
					{@const meta = item.examples.find((x) => x.file === ex.file)}
					<div class="flex flex-col gap-3">
						<h3 class="type-title text-fg-1">{meta?.title}</h3>
						{#if meta?.description}<p class="type-body text-fg-2">{meta.description}</p>{/if}
						<DemoBlock
							id="example-{ex.file}"
							component={ex.component}
							code={ex.code}
							html={ex.html}
						/>
					</div>
				{/each}
			</section>
		{/if}

		{#if item.parts?.length}
			<section class="flex flex-col gap-8">
				<SectionHeading id="api">API reference</SectionHeading>
				{#if item.deviations?.length}
					<div class="border-l-2 border-caution bg-surface-2 p-4">
						<p class="type-label text-caution-text">Deliberate differences from Base UI</p>
						<ul class="mt-2 list-disc pl-5 type-caption text-fg-2">
							{#each item.deviations as d (d)}<li>{d}</li>{/each}
						</ul>
					</div>
				{/if}
				{#each item.parts as part (part.name)}
					<div class="flex flex-col gap-3">
						<h3 id={partId(part.name)} class="scroll-mt-24 type-title text-fg-1">
							<code class="font-mono">{part.name}</code>
						</h3>
						<p class="type-body text-fg-2">
							{part.description}
							{#if part.engine}<span class="type-caption text-fg-3">
									Engine: {part.engine}.</span
								>{/if}
						</p>
						{#if part.props?.length}<ApiTable props={part.props} />{/if}
						{#if part.dataAttributes?.length}<ApiTable
								attrs={part.dataAttributes}
								attrLabel="Data attribute"
							/>{/if}
						{#if part.cssVariables?.length}<ApiTable
								attrs={part.cssVariables}
								attrLabel="CSS variable"
							/>{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if item.guidelines}
			<section class="flex flex-col gap-4">
				<SectionHeading id="guidelines">Guidelines</SectionHeading>
				<div class="grid gap-4 md:grid-cols-2">
					{#if item.guidelines.do?.length}
						<div class="border border-t-4 border-line-2 border-t-positive p-4">
							<p class="type-label text-positive-text">Do</p>
							<ul class="mt-2 flex list-disc flex-col gap-1 pl-5 type-caption text-fg-2">
								{#each item.guidelines.do as g (g)}<li>{g}</li>{/each}
							</ul>
						</div>
					{/if}
					{#if item.guidelines.dont?.length}
						<div class="border border-t-4 border-line-2 border-t-accent-2 p-4">
							<p class="type-label text-accent-2-text">Don’t</p>
							<ul class="mt-2 flex list-disc flex-col gap-1 pl-5 type-caption text-fg-2">
								{#each item.guidelines.dont as g (g)}<li>{g}</li>{/each}
							</ul>
						</div>
					{/if}
				</div>
			</section>
		{/if}
	</article>
	<aside class="ds-toc hidden w-52 shrink-0 self-start xl:block">
		<Toc items={toc} />
	</aside>
</div>

<style>
	.ds-toc {
		position: sticky;
		top: calc(var(--nav-bar-offset) + var(--ds-header-height) + var(--ds-space-10));
	}
</style>
