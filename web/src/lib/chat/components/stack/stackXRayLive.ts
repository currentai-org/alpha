// Maps live-stack node ids (reveal.ts / ap:flash) → roadmap product slugs for Stack X-Ray.

import { PROVENANCE_ID_MAP } from "./stackRoadmap";

/** Map one stack-map node id to a roadmap product slug (pass-through if already a slug). */
export function stackNodeToProductId(nodeId: string): string {
	return PROVENANCE_ID_MAP[nodeId] ?? nodeId;
}

export function stackNodesToProductIds(nodeIds: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const id of nodeIds) out.add(stackNodeToProductId(id));
	return [...out];
}
