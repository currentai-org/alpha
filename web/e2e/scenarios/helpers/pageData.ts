/**
 * A page's own load data, from the body SvelteKit serves at `<path>/__data.json`: the flat array of
 * the data node whose root object carries `rootKey`. Each root field holds the index of its value in
 * that array, so `flat[flat[0].someKey]` is the value. Undefined when no node carries `rootKey`.
 */
export function pageDataNode(body: unknown, rootKey: string): Record<string, number>[] | undefined {
	const { nodes } = body as { nodes: ({ type: string; data: unknown[] } | null)[] };
	for (const node of nodes) {
		if (node?.type !== 'data') continue;
		const flat = node.data as Record<string, number>[];
		if (flat[0] && typeof flat[0] === 'object' && rootKey in flat[0]) return flat;
	}
	return undefined;
}
