// The one permission model every workspace uses. Three switches live on the `organization`
// record (schema.ts) and every screen reads them from HERE, not from a bare string literal — an
// organisation's Alpha and the Current AI Alpha are the same object with these set differently, and
// that only holds if nothing hardcodes a value.
//
// Only "invitation" (joinMethod) and "admin_only" (configChangeRule) have a live mechanism behind them
// today — CUR-550 built invite-by-email, and Better Auth's own admin/member access control enforces
// admin-only member management. The other join methods are refused on write until they have a flow
// (CUR-3021, JOIN_METHODS_WITH_A_FLOW); the other config-change rules are storable and displayable so CUR-551
// (admin config screen) and CUR-554 (member change-requests) — both separate, already-ticketed work —
// have a stable contract to build against, not a placeholder they'd need to redefine. (CUR-826)

export const JOIN_METHODS = ["invitation", "request", "open"] as const;
export type JoinMethod = (typeof JOIN_METHODS)[number];

export const CONFIG_CHANGE_RULES = [
	"admin_only",
	"members_propose_admin_approves",
	"members_propose_auto_apply",
] as const;
export type ConfigChangeRule = (typeof CONFIG_CHANGE_RULES)[number];

// Single legal value today — see the schema.ts column comment for why this is a real column anyway.
export const RULES_VISIBILITIES = ["always"] as const;
export type RulesVisibility = (typeof RULES_VISIBILITIES)[number];

export const JOIN_METHOD_LABELS: Record<JoinMethod, string> = {
	invitation: "By invitation only",
	request: "By request — an admin approves",
	open: "Open — anyone can join",
};

export const CONFIG_CHANGE_RULE_LABELS: Record<ConfigChangeRule, string> = {
	admin_only: "Admins only",
	members_propose_admin_approves: "Members propose, an admin approves",
	members_propose_auto_apply: "Members propose, applied once the rules are met",
};

// The join methods someone can actually use to get in. Better Auth stores `joinMethod` as a
// free string, so without this a workspace could be saved as "open" with no way to join it openly.
// Rows that already hold another value still display through joinMethodLabel. (CUR-3021)
const JOIN_METHODS_WITH_A_FLOW: readonly JoinMethod[] = ["invitation"];

/** The refusal to show when a workspace is created or updated with a join method nobody can use yet,
 *  or null when the value is absent (left as it is) or has a working flow. */
export function joinMethodRefusal(value: unknown): string | null {
	if (value === undefined) return null;
	if (JOIN_METHODS_WITH_A_FLOW.includes(value as JoinMethod)) return null;
	return "People can join a workspace by invitation only for now. Invite them by email from the workspace settings.";
}

// A workspace's name goes into the invitation email a stranger receives, so it must not be
// able to carry a link or a paragraph. Checked server-side on create and rename (betterAuth.ts); the
// page's inputs share the length so a person hits the limit while typing. (CUR-3194)
export const WORKSPACE_NAME_MAX = 60;

// A scheme, a "www." prefix, or a dotted name ending in a 2+ letter label ("example.com", "bit.ly/x").
// "Dept. of Health" passes: its dot is followed by a space.
const LINK_SHAPE = /:\/\/|\bwww\.|[a-z0-9-]\.[a-z]{2,}\b/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

/** The refusal to show for a workspace name, or null when it is absent (left as it is) or fine. */
export function workspaceNameRefusal(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string") return "A workspace needs a name.";
	const name = value.trim();
	if (!name) return "A workspace needs a name.";
	if (name.length > WORKSPACE_NAME_MAX)
		return `Workspace names can be up to ${WORKSPACE_NAME_MAX} characters.`;
	if (CONTROL_CHARS.test(name)) return "Workspace names can't contain hidden or control characters.";
	if (LINK_SHAPE.test(name) || name.includes("@"))
		return "Workspace names can't contain a link, a web address or an email address.";
	return null;
}

export function joinMethodLabel(value: string): string {
	return JOIN_METHOD_LABELS[value as JoinMethod] ?? value;
}

export function configChangeRuleLabel(value: string): string {
	return CONFIG_CHANGE_RULE_LABELS[value as ConfigChangeRule] ?? value;
}
