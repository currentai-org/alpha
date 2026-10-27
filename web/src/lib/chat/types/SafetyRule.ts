// A curated, PUBLIC-SAFE safety rule for the client to render as a card — the catalog of named Coop
// block rules. ONLY the reviewed label + its tier ship to the client; the raw Coop action code never
// does (see $lib/chat/server/ruleLabel). The card matching the active block is highlighted by LABEL equality,
// so no raw action identity is needed client-side. `kind` groups the catalog by tier (content vs child).
export type SafetyRule = {
	label: string;
	kind: "content" | "child";
};
