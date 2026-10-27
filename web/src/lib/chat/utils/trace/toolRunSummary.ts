// Adapted from NousResearch/hermes-agent's summarizeToolRun (apps/desktop/src/components/
// assistant-ui/tool/run-summary.ts, MIT, Copyright Nous Research 2025) — CUR-775. Kept: the
// RunCategory/CATEGORY_ORDER/CATEGORY_COPY table shape (fixed clause order + noun singular/plural +
// past-tense verb) that makes the line deterministic. Dropped: toolTarget()/summarizeShellCommand()
// and live/pending present-tense narration — both need per-call args (a file path, a command line) or
// which call is still outstanding; agent-service's wire never carries either by design
// (api/acp_client.py:344 redacts title/raw_input/raw_output/locations — kind + step index ONLY,
// tested at api/test_acp_client.py:175). This module only ever sees a COUNT per kind, so it can only
// ever answer "how many", never "which" or "what" — its only parameter type is ToolKindCounts, which
// cannot structurally carry the model's own prose, so nothing here can ever be overridden by it.

export type ToolKindCounts = Readonly<Record<string, number>>;

interface KindCopy {
	noun: readonly [string, string]; // [singular, plural]
	past: string;
}

// Kinds rendered in the user-facing sentence, in this fixed order. Distinct from the full coarse tool-
// kind taxonomy (edit, execute, read, delete, move, search, think, fetch, switch_mode, other) — think
// and switch_mode are internal bookkeeping a non-technical reader has no context for, so they're
// deliberately excluded here (still present in ToolKindCounts for logging/future use, just not
// narrated) — see SUPPRESSED_KINDS below for what happens when they're all a turn has.
const KIND_ORDER = ["edit", "execute", "delete", "move", "search", "read", "fetch"] as const;

const KIND_COPY: Record<(typeof KIND_ORDER)[number], KindCopy> = {
	edit: { noun: ["file", "files"], past: "Edited" },
	execute: { noun: ["command", "commands"], past: "Ran" },
	delete: { noun: ["file", "files"], past: "Deleted" },
	move: { noun: ["file", "files"], past: "Moved" },
	search: { noun: ["time", "times"], past: "Searched" },
	read: { noun: ["file", "files"], past: "Read" },
	fetch: { noun: ["resource", "resources"], past: "Fetched" },
};

// Same "say the least specific true thing, never drop it" posture INERT_TOOL_KINDS/
// CODE_ARTIFACT_EXTENSIONS already use in endpointAgent.ts — an extension either list hasn't caught up
// to yet (agent-service's own "other" bucket, or a future kind) must still show up, generically, rather
// than vanish.
const FALLBACK_COPY: KindCopy = { noun: ["tool call", "tool calls"], past: "Made" };

// Internal bookkeeping, silent by design — see KIND_ORDER's comment above.
const SUPPRESSED_KINDS = new Set(["think", "switch_mode"]);

function clause(copy: KindCopy, count: number): string {
	const noun = count === 1 ? copy.noun[0] : copy.noun[1];
	return `${copy.past} ${count} ${noun}`;
}

function lowerFirst(text: string): string {
	return text.length ? text[0].toLowerCase() + text.slice(1) : text;
}

export function summarizeToolRun(counts: ToolKindCounts): string {
	const clauses: string[] = [];
	for (const kind of KIND_ORDER) {
		const count = counts[kind];
		if (count) clauses.push(clause(KIND_COPY[kind], count));
	}

	// Anything not in KIND_ORDER and not deliberately suppressed (agent-service's "other" bucket, or a
	// future kind neither list has caught up to yet) always folds into one generic clause — mixed in
	// alongside real clauses or alone — so it's never silently dropped the way an unrecognized ACP kind
	// already isn't dropped elsewhere in this file's neighbors.
	let unknownTotal = 0;
	for (const [kind, count] of Object.entries(counts)) {
		if ((KIND_ORDER as readonly string[]).includes(kind)) continue;
		if (SUPPRESSED_KINDS.has(kind)) continue;
		unknownTotal += count;
	}
	if (unknownTotal > 0) clauses.push(clause(FALLBACK_COPY, unknownTotal));

	// think/switch_mode stay silent when anything else narratable happened this turn — but a turn that
	// ONLY thought or switched mode still genuinely ran something, and rendering nothing would misreport
	// that as "no tools ran" rather than "nothing externally visible ran". Only reached when the loops
	// above produced zero clauses.
	if (clauses.length === 0) {
		const suppressedTotal = Object.entries(counts)
			.filter(([kind]) => SUPPRESSED_KINDS.has(kind))
			.reduce((sum, [, count]) => sum + count, 0);
		if (suppressedTotal > 0) clauses.push(clause(FALLBACK_COPY, suppressedTotal));
	}

	return clauses.map((c, i) => (i === 0 ? c : lowerFirst(c))).join(", ");
}
