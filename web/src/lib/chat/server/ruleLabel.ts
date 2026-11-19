import type { SafetyRule } from "$lib/chat/types/SafetyRule";
import RULES from "$lib/chat/server/rules.json";
import { declineMessage, declineNotice, type DeclineLanguage } from "$lib/chat/server/declineCopy";

// CURATED, PUBLIC-SAFE rule catalog for Coop block actions — the SINGLE place a rule gets a public name
// AND its user-facing decline message. Edit `rules.json` (one entry per Coop action):
//
//   "chat-block-<x>": { "label": "Short card name", "message": "Full sentence the user sees." }
//
// Coop returns the ACTION NAME a turn triggered (e.g. "chat-block-violence"). By the operator's 1:1
// rule→action convention that action name IS the rule identity. `label` is the short card name; `message`
// is the full decline copy shown in place of the answer. `message` is OPTIONAL — omit it and the generic,
// reviewed decline copy stands (so e.g. violence and drugs can carry different text, or share the default).
//
// The KEY must match the Coop action name EXACTLY. If the operator named the rule "chat-block-sycophancy"
// (correct spelling) in the Coop dashboard, a mis-keyed entry won't match and nothing surfaces — verify the
// action name in Coop, don't assume. The label/message VALUES are user-facing and safe to spell correctly
// regardless of the key.
//
// Honors the moderation seam's contract (see $lib/chat/server/moderation, "Coop action names carry NO
// user-facing text"): a raw action code must NEVER reach the user, and we never auto-humanize the slug.
// An action with no entry here resolves to `null` for both label and message, and the generic copy stands.
//
// SERVER-SIDE ONLY: resolveActionLabel/resolveActionMessage run where the message is stamped (the route
// handler + the output-screen stream). Only the resolved values are placed on the message; the raw action
// stays internal. Keys in rules.json MUST match the Coop action name EXACTLY (including any child prefix).
type RuleEntry = { label: string; message?: string };
// rules.json v2 (Shieldstral swap) carries reserved `_`-prefixed config blocks (`_shield`: the global
// screening knobs) alongside the rule entries. Those are NOT rules — skip them so they never become
// a label, an ACTION_LABELS entry, or a catalog card. Only `chat-block-*` keys are user-facing rules.
const RULE_MAP: Record<string, RuleEntry> = Object.fromEntries(
	Object.entries(RULES as Record<string, unknown>).filter(([key]) => !key.startsWith("_"))
) as Record<string, RuleEntry>;

// Back-compat + the catalog source: action → label, derived from rules.json.
export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
	Object.entries(RULE_MAP).map(([action, entry]) => [action, entry.label])
);

// Optional kill switch: COOP_SURFACE_RULE_LABEL=false|0|off suppresses ALL curated copy at runtime — both
// labels AND custom messages (the decline still fires; only the reviewed public copy is withheld, so the
// generic decline text stands). Any other value — including unset — keeps it on. Read at CALL TIME so it can
// flip without a redeploy, matching the moderation seam's getters.
function ruleLabelEnabled(): boolean {
	const raw = (process.env.COOP_SURFACE_RULE_LABEL ?? "").trim().toLowerCase();
	return raw !== "false" && raw !== "0" && raw !== "off";
}

// Resolve a Coop action name to its curated public label, or null when there is no reviewed label for it
// (unknown/unmapped action, empty input, or the kill switch is off). Callers treat null as "no label" and
// fall back to the generic, reviewed safety copy — they MUST NOT show the raw action on a null.
export function resolveActionLabel(action?: string | null): string | null {
	if (!action || !ruleLabelEnabled()) return null;
	return RULE_MAP[action]?.label ?? null;
}

// The self-harm rules carry crisis-support copy, not a policy decline, so they get no "who set this limit"
// line: a person in crisis reads the support resources and nothing else (same set as guardGate.ts).
const SUPPORT_RULE_KEYS = new Set([
	"chat-block-self-harm",
	"chat-block-self-harm-eating",
	"chat-block-self-harm-intent",
	"chat-block-self-harm-passive",
	"chat-block-self-harm-hedged",
]);

// A person asking Alpha to be a partner, friend or therapist may be lonely, so that rule's warm copy
// carries no "who set this limit" line either. Both read in the person's language.
const NO_ATTRIBUTION_KEYS = new Set(["chat-block-anthro"]);

/** True for the self-harm rules, which carry crisis support: the client leads that turn, declined or
 * answered, with the Support resources card even when the person's words miss the card's own
 * client-side check. */
export function isSupportRule(action?: string | null): boolean {
	return !!action && SUPPORT_RULE_KEYS.has(action);
}

// Resolve a Coop action name to its curated per-rule decline MESSAGE, or null when the action has no custom
// message (unmapped, no `message` field, empty input, or the kill switch is off). Callers use this to REPLACE
// the generic decline copy for that block; on null they keep the generic, reviewed default.
// /about promises that a refusal "tells you who set that limit", so a policy decline ends with
// that line. Both read in `lang`, the language the person wrote in, where declineCopy.ts has it.
// `multiple`: more than one labeled rule blocked the turn, so the attribution line names them together.
export function resolveActionMessage(
	action?: string | null,
	lang: DeclineLanguage = "en",
	multiple = false
): string | null {
	if (!action || !ruleLabelEnabled()) return null;
	const entry = RULE_MAP[action];
	if (!entry?.message) return null;
	if (SUPPORT_RULE_KEYS.has(action) || NO_ATTRIBUTION_KEYS.has(action)) return declineMessage(entry.message, lang);
	return declineNotice(entry.message, multiple ? MULTIPLE_RULES_LABEL : entry.label, lang);
}

/** The attribution line's rule name when more than one labeled rule blocked a turn. */
const MULTIPLE_RULES_LABEL = "Multiple Safety Rules";

/** The label of every content rule that blocked a turn, deduplicated, the shown rule's first. A self-harm
 *  decline names only its own rule, since a person in crisis reads only the support copy. Empty when the
 *  shown rule has no reviewed label or the kill switch is off. */
export function blockedRuleLabels(
	hits: ReadonlyArray<{ key: string; action: "block" | "log"; tier: "child" | "content" }> | undefined,
	shown?: string | null
): string[] {
	const first = resolveActionLabel(shown);
	if (!first) return [];
	if (isSupportRule(shown)) return [first];
	const labels = new Set([first]);
	for (const h of hits ?? []) {
		if (h.action !== "block" || h.tier !== "content" || isSupportRule(h.key)) continue;
		const label = resolveActionLabel(h.key);
		if (label) labels.add(label);
	}
	return [...labels];
}

// The PUBLIC catalog of named safety rules, for the client to render as cards (one card per rule, the
// triggering one highlighted). Derived from rules.json: deduped by label, with the tier inferred from the
// action key (the child prefix `chat-block-child` is a content sub-namespace, so it's checked first). Ships
// ONLY the reviewed labels + tier — never the raw action codes or messages — so it is safe to send to the
// client (via page.data). Empty when the kill switch suppresses labels, so no rule names surface anywhere.
export function ruleLabelCatalog(): SafetyRule[] {
	if (!ruleLabelEnabled()) return [];
	const seen = new Set<string>();
	const rules: SafetyRule[] = [];
	for (const [action, entry] of Object.entries(RULE_MAP)) {
		if (seen.has(entry.label)) continue;
		seen.add(entry.label);
		rules.push({ label: entry.label, kind: action.startsWith("chat-block-child") ? "child" : "content" });
	}
	return rules;
}
