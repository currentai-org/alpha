// Shape of static/data/stack-map.json (baked from the Open Source AI Market Map
// catalog). Ported from the Next chat/ app (components/stack/types.ts).
export type StackStatus = "live" | "building" | "gap" | "wanted";

export type NodeAtlas = {
	pid: string;
	stars: number | null;
	stars7d: number | null;
	contributors: number | null;
	commits90d: number | null;
	language: string | null;
	license: string | null;
	desc: string | null;
	url: string | null;
	openness: string;
	sparkline: number[] | null;
};

// Training-data / dataset lineage shown behind a node's provenance — the
// "trace it yourself" depth. Only attached where the facts are verifiable from
// an authoritative source (e.g. the model's own card + technical report).
export type NodeLineage = {
	summary: string;
	facts?: string[];
	links?: { label: string; url: string }[];
};

export type StackNode = {
	id: string;
	nm: string;
	org: string;
	st: StackStatus;
	d: string;
	prov?: string | null;
	url?: string | null;
	atlas?: NodeAtlas | null;
	lineage?: NodeLineage | null;
};

export type StackLayer = {
	label: string;
	ghost: boolean;
	nodes: StackNode[];
};

export type StackMapData = {
	generatedFrom: string;
	layers: StackLayer[];
	coverage: Record<StackStatus, number>;
};

export const STATUS_LABEL: Record<StackStatus, string> = {
	live: "LIVE",
	building: "BUILDING",
	gap: "GAP",
	wanted: "WANTED",
};

export const STATUS_VAR: Record<StackStatus, string> = {
	live: "var(--ap-live)",
	building: "var(--ap-building)",
	gap: "var(--ap-gap)",
	wanted: "var(--ap-wanted)",
};

// AA-compliant variants for status text (labels + coverage legend). The bright STATUS_VAR
// hues stay for fills/dots/borders; these darker tints keep the LABEL text readable (WCAG AA).
export const STATUS_TEXT_VAR: Record<StackStatus, string> = {
	live: "var(--ap-live-text)",
	building: "var(--ap-building-text)",
	gap: "var(--ap-gap-text)",
	wanted: "var(--ap-ink-3)",
};
