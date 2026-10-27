// Roadmap-driven stack model for the "Behind the scenes" stack view.
//
// DATA SOURCE: ./roadmapData.generated.ts — compiled from the roadmap spreadsheet by
// `npm run build:roadmap` (scripts/build-roadmap.mjs), gated to display_in_provenance == "yes". Do NOT hand-edit
// product rows; edit the spreadsheet, re-export the CSV, and re-run the build. This file is the LOGIC layer: types,
// curated links, and derived views (matrix cells, query path, coverage, activation rows).
//
// Three axes on each product:
//   - layer   → the stack tier (y-axis row), top (user-facing) to bottom (infra)
//   - bucket  → now / next / later (x-axis column)
//   - status  → live / building / gap, drives the dot colour (--ap-live/-building/-gap)
// `path` (1..N, else 0) is the order a chat turn flows DOWN the stack — the sequence the matrix lights up
// when a query runs. Honest by intent: only products that genuinely participate in answering a turn are on-path.

import type { StackStatus } from "./types";
import { ROADMAP_PRODUCTS as BASE_PRODUCTS } from "./roadmapData.generated";

export type RoadmapBucket = "now" | "next" | "later";

export type RoadmapProduct = {
	id: string;
	name: string;
	layer: string;
	bucket: RoadmapBucket;
	status: StackStatus; // live | building | gap (roadmap has no "wanted")
	path: number; // position on the query path, 0 = not on path
	desc: string;
	// Enrichment from the roadmap Sheet — present only when authored. Open source lineage + partner attribution.
	osProduct?: string; // the open source product this is built on / referenced
	osOptions?: string[]; // swap-in open source alternatives
	maintainers?: string[]; // sanitized partner orgs (speculative "?" entries are dropped at build time)
	url?: string; // canonical public destination for this component (open weights, homepage, …)
	provenance?: string; // deeper provenance / training-data lineage sentence (marquee rows only)
	provenanceLinks?: { label: string; url: string }[]; // supporting links (technical report, data recipe, …)
	link?: string; // resolved "learn more" href (Sheet url, else a curated PRODUCT_LINKS route)
	linkLabel?: string;
};

// Honest "learn more" targets — only where a REAL public destination exists. Curated here (NOT from the Sheet);
// a product without an entry simply shows its description on expand, no link. Extend deliberately (every link
// must resolve; a dead link reads as overclaiming on a provenance surface).
const PRODUCT_LINKS: Record<string, { href: string; label: string }> = {
	"foundation-model": {
		href: "https://huggingface.co/swiss-ai",
		label: "Open weights on Hugging Face",
	},
	"trust-and-safety": { href: "/trust-and-safety", label: "Our Trust & Safety policy" },
};

// Stack tiers, top → bottom. The query falls down this order.
export const ROADMAP_LAYERS: { key: string; label: string }[] = [
	{ key: "clients", label: "Clients" },
	{ key: "agents", label: "Agents" },
	{ key: "orchestration", label: "Routing" },
	{ key: "knowledge", label: "Knowledge" },
	{ key: "serving", label: "Serving" },
	{ key: "models", label: "Models" },
	{ key: "compute", label: "Compute" },
	{ key: "data", label: "Data" },
	{ key: "trust", label: "Trust" },
];

export const ROADMAP_BUCKETS: { key: RoadmapBucket; label: string }[] = [
	{ key: "now", label: "Now" },
	{ key: "next", label: "Next" },
	{ key: "later", label: "Later" },
];

// The generated rows carry everything except the curated learn-more link; attach it here. This enriched array
// is what the sidebar renders.
export const ROADMAP_PRODUCTS: RoadmapProduct[] = BASE_PRODUCTS.map((p) => ({
	...p,
	// Product slug is the canonical display name (e.g. inference-platform, stack-control-plane).
	name: p.id,
	// Sheet-authored url wins; fall back to a curated route (e.g. the internal /trust-and-safety page).
	link: p.url ?? PRODUCT_LINKS[p.id]?.href,
	linkLabel: PRODUCT_LINKS[p.id]?.label,
}));

// Product ids on the query path, in descend order.
export const QUERY_PATH: string[] = ROADMAP_PRODUCTS.filter((p) => p.path > 0)
	.sort((a, b) => a.path - b.path)
	.map((p) => p.id);

// Bridge the existing live-stack node ids (reveal.ts) → roadmap product ids, so real
// ap:flash / ap:pulse-* provenance events from a turn light the matching matrix dot.
export const PROVENANCE_ID_MAP: Record<string, string> = {
	apertus: "foundation-model",
	hermes: "agent-service",
	websearch: "web-search",
	"potluck-rag": "rag",
	"syft-rag": "federated-rag",
	"syft-epfl": "federated-rag",
	localculture: "community-workspace",
	router: "compute-router",
	safety: "trust-and-safety",
	cscs: "sovereign-compute",
};

export const STATUS_HEX_VAR: Record<StackStatus, string> = {
	live: "var(--ap-live)",
	building: "var(--ap-building)",
	gap: "var(--ap-gap)",
	wanted: "var(--ap-wanted)",
};

export type RoadmapCoverage = { live: number; building: number; gap: number };

export const ROADMAP_COVERAGE: RoadmapCoverage = ROADMAP_PRODUCTS.reduce(
	(acc, p) => {
		if (p.status === "live") acc.live++;
		else if (p.status === "building") acc.building++;
		else if (p.status === "gap") acc.gap++;
		return acc;
	},
	{ live: 0, building: 0, gap: 0 }
);

// Precompute the (layer, bucket) → products grouping ONCE at module load. The matrix renders 9×3 = 27
// cells; a naive per-cell filter over all products is O(layers·buckets·products) re-run on every reactive
// invalidation (e.g. each reveal tick). One O(products) pass here makes each cell an O(1) Map lookup.
const CELLS = new Map<string, RoadmapProduct[]>();
for (const p of ROADMAP_PRODUCTS) {
	const key = `${p.layer}:${p.bucket}`;
	const cell = CELLS.get(key);
	if (cell) cell.push(p);
	else CELLS.set(key, [p]);
}
const EMPTY_CELL: readonly RoadmapProduct[] = [];

/** Products for one (layer, bucket) cell. O(1) lookup into the precomputed grouping. */
export function productsFor(layer: string, bucket: RoadmapBucket): readonly RoadmapProduct[] {
	return CELLS.get(`${layer}:${bucket}`) ?? EMPTY_CELL;
}

// ---- Activation view -------------------------------------------------------------------------------------
// One representative product per layer, for the layer-row "activation" view (rows light up as a query
// descends). Pick the on-path product (lowest path — the one that actually fires for this layer), else the
// highest-status product, else the first. Layers with no shown products (e.g. Compute) are dropped.
const STATUS_RANK: Record<StackStatus, number> = { live: 3, building: 2, gap: 1, wanted: 0 };

export type LayerRow = {
	layer: string;
	label: string;
	product: RoadmapProduct;
	maintainer?: string;
};

export const ACTIVATION_ROWS: LayerRow[] = ROADMAP_LAYERS.flatMap(({ key, label }) => {
	const inLayer = ROADMAP_PRODUCTS.filter((p) => p.layer === key);
	if (!inLayer.length) return []; // layer has no shown products (e.g. Compute) → drop the row
	const onPath = inLayer.filter((p) => p.path > 0).sort((a, b) => a.path - b.path);
	const product =
		onPath[0] ?? [...inLayer].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];
	return [{ layer: key, label, product, maintainer: product.maintainers?.[0] }];
});
