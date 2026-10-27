/**
 * Catalog registry — discovers every documented item by convention.
 *
 *   <layer>/<slug>/<slug>.docs.ts     default export: DocEntry
 *   <layer>/<slug>/examples/*.svelte  live examples (component + raw source for the code tab)
 *
 * Adding a component folder with those two things is all it takes to appear in /designsystem.
 * `registry.spec.ts` fails if a folder is missing either, or if a docs entry points at an example
 * file that does not exist.
 */
import type { Component } from 'svelte';
import type { DocEntry, Layer } from './types.ts';

const docModules = import.meta.glob<{ default: DocEntry }>(
	'../{components,primitives,patterns}/*/*.docs.ts',
	{ eager: true }
);
const exampleLoaders = import.meta.glob<{ default: Component }>(
	'../{components,primitives,patterns}/*/examples/*.svelte'
);
const exampleSources = import.meta.glob<string>(
	'../{components,primitives,patterns}/*/examples/*.svelte',
	{
		query: '?raw',
		import: 'default',
		eager: true
	}
);

const folderOf = (path: string) => path.split('/').slice(1, 3).join('/'); // "components/button"

export interface CatalogItem extends DocEntry {
	/** `components/button` */
	folder: string;
}

export interface FoundationPage {
	slug: string;
	name: string;
	layer: 'foundation';
	description: string;
	keywords?: string[];
}

/** Foundations are hand-built pages in the route (they document tokens, not a folder). */
export const FOUNDATIONS: FoundationPage[] = [
	{
		slug: 'overview',
		name: 'Overview',
		layer: 'foundation',
		description: 'How the system is layered and where to start.',
		keywords: ['intro', 'getting started', 'architecture']
	},
	{
		slug: 'colors',
		name: 'Color',
		layer: 'foundation',
		description: 'OKLCH semantic ladder — surfaces, text, rules, accents — with live contrast.',
		keywords: ['oklch', 'palette', 'tokens', 'background', 'text', 'border', 'accent', 'contrast']
	},
	{
		slug: 'surfaces',
		name: 'Surfaces',
		layer: 'foundation',
		description:
			'The three background tiers and the surface context that makes “one tier up” automatic.',
		keywords: ['elevation', 'background', 'data-surface', 'layer']
	},
	{
		slug: 'typography',
		name: 'Typography',
		layer: 'foundation',
		description: 'Three typefaces, six sizes, named type roles.',
		keywords: ['font', 'type', 'text', 'size', 'jakarta', 'dm mono', 'noto serif']
	},
	{
		slug: 'spacing',
		name: 'Spacing & size',
		layer: 'foundation',
		description: '4px grid, control heights, layout dimensions.',
		keywords: ['space', 'gap', 'padding', 'grid', 'size']
	},
	{
		slug: 'shape',
		name: 'Shape & elevation',
		layer: 'foundation',
		description: 'Radius tiers, rule weights, the one shadow.',
		keywords: ['radius', 'border', 'shadow', 'rounded']
	},
	{
		slug: 'motion',
		name: 'Motion',
		layer: 'foundation',
		description: 'Short, hard, reduced-motion aware.',
		keywords: ['animation', 'duration', 'easing', 'transition']
	},
	{
		slug: 'utilities',
		name: 'Utilities',
		layer: 'foundation',
		description: 'Hand-authored utilities: ink tints, motion, scroll fades, masks, XRAY.',
		keywords: ['utility', 'tint', 'hover', 'mask', 'scroll-fade', 'fade', 'xray', 'swatch', 'css']
	},
	{
		slug: 'icons',
		name: 'Icons',
		layer: 'foundation',
		description: 'Remix Icon, line vs fill, colour by role.',
		keywords: ['remix', 'icon', 'svg']
	},
	{
		slug: 'theming',
		name: 'Theming',
		layer: 'foundation',
		description: 'Seeds → full light/dark ladder. Live playground.',
		keywords: ['theme', 'dark mode', 'light mode', 'playground', 'seed']
	},
	{
		slug: 'changelog',
		name: 'Changelog',
		layer: 'foundation',
		description: 'The version, derived from one entry per change, and what each change did.',
		keywords: ['version', 'semver', 'release', 'history', 'changes', 'ds:change', 'breaking']
	},
	{
		slug: 'linting',
		name: 'Design lint',
		layer: 'foundation',
		description: 'The rules that keep new code on-system, and how to run them.',
		keywords: ['lint', 'eslint', 'rules', 'shadcn']
	}
];

export const ITEMS: CatalogItem[] = Object.entries(docModules)
	.map(([path, mod]) => ({ ...mod.default, folder: folderOf(path) }))
	.sort((a, b) => a.name.localeCompare(b.name));

export const LAYERS: { layer: Layer; label: string; blurb: string }[] = [
	{
		layer: 'foundation',
		label: 'Foundations',
		blurb: 'Tokens and rules everything else is built from.'
	},
	{
		layer: 'component',
		label: 'Components',
		blurb: 'Base UI–shaped parts. Skin lives in each recipe.'
	},
	{ layer: 'primitive', label: 'Primitives', blurb: 'Layout: group elements together.' },
	{ layer: 'pattern', label: 'Patterns', blurb: 'Page structure: sidebar, conversation and side panel.' }
];

export type NavEntry = {
	slug: string;
	name: string;
	layer: Layer;
	description: string;
	keywords?: string[];
	baseUi?: DocEntry['baseUi'];
};

export function navEntries(): NavEntry[] {
	return [...FOUNDATIONS, ...ITEMS];
}

export function getItem(slug: string): CatalogItem | undefined {
	return ITEMS.find((i) => i.slug === slug);
}

export function getFoundation(slug: string): FoundationPage | undefined {
	return FOUNDATIONS.find((f) => f.slug === slug);
}

const examplePath = (item: CatalogItem, file: string) =>
	`../${item.folder}/examples/${file}.svelte`;

export function exampleSource(item: CatalogItem, file: string): string | undefined {
	return exampleSources[examplePath(item, file)];
}

export function loadExample(
	item: CatalogItem,
	file: string
): Promise<{ default: Component }> | undefined {
	return exampleLoaders[examplePath(item, file)]?.();
}

/** Every discovered folder, whether or not it has docs — for the coverage test. */
export const DISCOVERED_EXAMPLE_PATHS = Object.keys(exampleSources);

/** Rank entries for a search query: name prefix > name substring > keyword/part > description. */
export function search(query: string): NavEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return navEntries();
	const scored = navEntries()
		.map((e) => {
			const name = e.name.toLowerCase();
			const parts =
				'parts' in e ? ((e as CatalogItem).parts ?? []).map((p) => p.name.toLowerCase()) : [];
			let score = 0;
			if (name.startsWith(q)) score = 100;
			else if (name.includes(q)) score = 80;
			else if (e.slug.includes(q)) score = 70;
			else if ((e.keywords ?? []).some((k) => k.toLowerCase().includes(q))) score = 60;
			else if (parts.some((p) => p.includes(q))) score = 50;
			else if (e.description.toLowerCase().includes(q)) score = 30;
			else if (e.baseUi?.name.toLowerCase().includes(q)) score = 20;
			return { e, score };
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
	return scored.map((r) => r.e);
}
