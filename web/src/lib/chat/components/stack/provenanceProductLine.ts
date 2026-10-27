// "[os_product] by [maintainer]" attribution from roadmap provenance products.

import { PROVENANCE_PRODUCTS } from "./provenanceProducts.generated";
import type { ProvenanceProduct } from "./provenanceProducts.generated";
import { PROVENANCE_ID_MAP } from "./stackRoadmap";

const BY_SLUG = new Map(PROVENANCE_PRODUCTS.map((p) => [p.name, p]));

export function provenanceProductBySlug(slug: string): ProvenanceProduct | undefined {
	return BY_SLUG.get(slug);
}

export function provenanceProductByNode(nodeId: string): ProvenanceProduct | undefined {
	const slug = PROVENANCE_ID_MAP[nodeId];
	return slug ? BY_SLUG.get(slug) : undefined;
}

/** Plain-text attribution: "Firecrawl by …" — only when os_product is set. */
export function formatProductAttribution(product: {
	os_product: string | null;
	maintainers: string[];
}): string | undefined {
	const os = product.os_product?.trim();
	if (!os) return undefined;
	const maintainer = product.maintainers[0]?.trim();
	return maintainer ? `${os} by ${maintainer}` : os;
}

export function productAttributionForSlug(slug: string): string | undefined {
	const product = provenanceProductBySlug(slug);
	return product ? formatProductAttribution(product) : undefined;
}

export function productAttributionForNode(nodeId: string): string | undefined {
	const product = provenanceProductByNode(nodeId);
	return product ? formatProductAttribution(product) : undefined;
}
