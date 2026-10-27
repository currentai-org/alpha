import { getItem, loadExample } from '@aipotluck/alpha-ds/catalog/registry';
import type { PageLoad } from './$types';

/** Attaches each example's Svelte component so previews render on the server and hydrate. */
export const load: PageLoad = async ({ data }) => {
	if (data.kind !== 'item') return data;
	const item = getItem(data.slug)!;
	const examples = await Promise.all(
		data.examples.map(async (ex) => ({
			...ex,
			component: (await loadExample(item, ex.file))?.default
		}))
	);
	return { ...data, examples };
};
