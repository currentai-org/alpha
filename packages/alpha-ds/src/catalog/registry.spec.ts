import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISCOVERED_EXAMPLE_PATHS, exampleSource, ITEMS, search } from './registry.ts';
import { DOCUMENTED_UTILITIES } from './foundations/utilities.ts';

const recipeModules = import.meta.glob<Record<string, unknown>>(
	'../{components,primitives,patterns}/*/*.recipe.ts',
	{ eager: true }
);

const root = resolve(import.meta.dirname, '..');
const folders = (layer: string) =>
	readdirSync(join(root, layer)).filter((f) => statSync(join(root, layer, f)).isDirectory());

describe('catalog coverage — a component that is not documented does not exist to the next agent', () => {
	for (const layer of ['components', 'primitives', 'patterns']) {
		for (const folder of folders(layer)) {
			describe(`${layer}/${folder}`, () => {
				it('has a <slug>.docs.ts whose slug equals the folder name', () => {
					expect(existsSync(join(root, layer, folder, `${folder}.docs.ts`))).toBe(true);
					expect(ITEMS.find((i) => i.folder === `${layer}/${folder}`)?.slug).toBe(folder);
				});
				it('has at least one example, and every example it lists is a real file', () => {
					const item = ITEMS.find((i) => i.folder === `${layer}/${folder}`)!;
					expect(item.examples.length).toBeGreaterThan(0);
					for (const ex of item.examples) {
						expect(exampleSource(item, ex.file), `${folder}/examples/${ex.file}.svelte`).toBeTypeOf(
							'string'
						);
					}
				});
				it('has an index.ts entry point', () => {
					expect(existsSync(join(root, layer, folder, 'index.ts'))).toBe(true);
				});
			});
		}
	}

	it('no example file is orphaned (unlisted in its docs)', () => {
		const listed = new Set(
			ITEMS.flatMap((i) => i.examples.map((e) => `../${i.folder}/examples/${e.file}.svelte`))
		);
		expect(DISCOVERED_EXAMPLE_PATHS.filter((p) => !listed.has(p))).toEqual([]);
	});

	it('example code imports from the public barrel, so it is copy-pasteable', () => {
		for (const item of ITEMS) {
			for (const ex of item.examples) {
				const src = exampleSource(item, ex.file)!;
				expect(src, `${item.slug}/${ex.file}`).not.toMatch(/from '\.\.?\//);
			}
		}
	});

	it('every Base UI mapping links to base-ui.com', () => {
		for (const item of ITEMS.filter((i) => i.baseUi)) {
			expect(item.baseUi!.url).toMatch(/^https:\/\/base-ui\.com\/react\/components\//);
		}
	});
});

describe('docs track the code — the catalog is only useful if it is current', () => {
	it('every recipe variant value is named in its docs prop type (a new variant needs a doc line)', () => {
		const missing: string[] = [];
		for (const [path, mod] of Object.entries(recipeModules)) {
			const folder = path.split('/').slice(1, 3).join('/');
			const props = (ITEMS.find((i) => i.folder === folder)?.parts ?? []).flatMap(
				(p) => p.props ?? []
			);
			for (const [exportName, recipe] of Object.entries(mod)) {
				const variants = (recipe as { variants?: Record<string, Record<string, unknown>> })
					?.variants;
				if (!variants) continue;
				for (const [key, values] of Object.entries(variants)) {
					const prop = props.find((p) => p.name === key);
					if (!prop) {
						missing.push(`${folder} ${exportName}.${key} (no prop)`);
						continue;
					}
					for (const v of Object.keys(values)) {
						if (v !== 'true' && v !== 'false' && !prop.type.includes(`'${v}'`))
							missing.push(`${folder} ${exportName}.${key}='${v}'`);
					}
				}
			}
		}
		expect(Object.keys(recipeModules).length).toBeGreaterThan(0);
		expect(missing).toEqual([]);
	});

	it('every @utility in tokens/utilities.css is on the Utilities page, and nothing stale is', () => {
		const utilitiesCss = readFileSync(join(root, 'tokens/utilities.css'), 'utf8');
		const inCss = [...utilitiesCss.matchAll(/^@utility\s+([\w-]+)/gm)].map((m) => m[1]).sort();
		expect(inCss.length).toBeGreaterThan(0);
		expect([...DOCUMENTED_UTILITIES].sort()).toEqual(inCss);
	});
});

describe('search', () => {
	it('ranks a name prefix first', () => {
		expect(search('acc')[0].slug).toBe('accordion');
	});
	it('finds by keyword (modal → dialog)', () => {
		expect(search('modal').map((e) => e.slug)).toContain('dialog');
	});
	it('finds foundations (oklch → colors)', () => {
		expect(search('oklch').map((e) => e.slug)).toContain('colors');
	});
	it('returns nothing for gibberish rather than everything', () => {
		expect(search('zzqqxx')).toEqual([]);
	});
});
