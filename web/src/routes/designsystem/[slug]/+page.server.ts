import { error } from '@sveltejs/kit';
import { highlight } from '@aipotluck/alpha-ds/catalog/highlight.server';
import { FOUNDATION_SNIPPETS } from '@aipotluck/alpha-ds/catalog/foundations/snippets';
import { exampleSource, getFoundation, getItem } from '@aipotluck/alpha-ds/catalog/registry';
import { changelogData } from '@aipotluck/alpha-ds/version/changelog.server';
import type { PageServerLoad } from './$types';

/**
 * Highlights every code block for the page on the server (Shiki never reaches the client).
 * The example COMPONENTS are loaded in +page.ts so previews server-render too.
 */
export const load: PageServerLoad = async ({ params }) => {
	const foundation = getFoundation(params.slug);
	if (foundation) {
		const raw = FOUNDATION_SNIPPETS[foundation.slug] ?? {};
		const snippets = Object.fromEntries(
			await Promise.all(
				Object.entries(raw).map(
					async ([key, s]) =>
						[key, { code: s.code, label: s.label, html: await highlight(s.code, s.lang) }] as const
				)
			)
		);
		const changelog = foundation.slug === 'changelog' ? changelogData() : undefined;
		return { kind: 'foundation' as const, slug: foundation.slug, snippets, changelog };
	}

	const item = getItem(params.slug);
	if (!item) error(404, `No design-system entry called “${params.slug}”.`);

	const examples = await Promise.all(
		item.examples.map(async (ex) => {
			const code = exampleSource(item, ex.file) ?? '';
			return { file: ex.file, code, html: await highlight(code) };
		})
	);
	return {
		kind: 'item' as const,
		slug: item.slug,
		examples,
		anatomyHtml: item.anatomy ? await highlight(item.anatomy) : undefined
	};
};
