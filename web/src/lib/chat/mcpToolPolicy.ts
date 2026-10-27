// A person's choice for one tool on a connected MCP server (CUR-3984), set in Settings → Connectors and
// stored with their settings as `mcpToolPolicies`, keyed by the tool's `server__tool` name.
//
//   allow  runs without the confirmation card, write tools included.
//   ask    the default: a tool that can change something waits for the card; a read-only one runs.
//   block  never runs, and is not offered to the model at all.
export const MCP_TOOL_POLICIES = ["allow", "ask", "block"] as const;

export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** A setting with no entry for a tool means today's behaviour. */
const DEFAULT_MCP_TOOL_POLICY: McpToolPolicy = "ask";

/** The most tools one person's map may hold. A server lists a handful; this only bounds a hostile body. */
export const MAX_MCP_TOOL_POLICIES = 500;

export function mcpToolPolicyFor(
	policies: Readonly<Record<string, McpToolPolicy>> | undefined,
	fnName: string
): McpToolPolicy {
	const p = policies?.[fnName];
	return p && (MCP_TOOL_POLICIES as readonly string[]).includes(p) ? p : DEFAULT_MCP_TOOL_POLICY;
}
