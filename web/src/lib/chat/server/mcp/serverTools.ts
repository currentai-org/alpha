// The tools every configured MCP server offers, under names that say which server owns them (CUR-3026).
// Listing connects to each server, so the result is cached per server for a few minutes; a server that
// is down drops out of the list for this turn and is retried on the next listing.
import { createHash } from "node:crypto";
import { logger } from "$lib/chat/server/logger";
import { connectMcp, type McpConnection } from "./client";
import { mcpToolToOpenAITool, readAnnotations, type McpTool, type McpToolAnnotations } from "./schema";
import type { McpServerConfig } from "./servers";

export type ServerTool = {
	/** The function name the model sees and calls: `server__tool`. */
	fnName: string;
	server: string;
	/** The tool's own name on its server. */
	tool: string;
	annotations?: McpToolAnnotations;
	/** SHA-256 of the tool as its server listed it (`toolSha256`). The version a pin or a person's
	 *  approval refers to: a server that rewrites the tool gets a new hash. */
	sha256: string;
	/** The OpenAI definition sent to the model. Annotations stay off it: they are our policy input,
	 *  not something the model should be asked to weigh. */
	definition: { type: "function"; function: { name: string; description: string; parameters: object } };
};

export type Connect = (server: McpServerConfig, timeoutMs: number) => Promise<McpConnection>;

/** Connects with the server's own headers and its origin-scoped fetch, never another server's. */
export const connectServer: Connect = (server, timeoutMs) =>
	connectMcp(server.url, {
		...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
		fetch: server.fetch,
		timeoutMs,
	});

// Listing runs before the first token, so a slow server must not hold the answer: past this budget the
// server's tools are left out of this turn.
const LIST_TIMEOUT_MS = 6_000;
const LIST_TTL_MS = 5 * 60_000;
// OpenAI-compatible hosts accept [a-zA-Z0-9_-]{1,64} as a function name.
const FN_NAME_MAX = 64;

/** Whether the tool may run without the person confirming. Only an explicit `readOnlyHint: true`
 *  counts; an absent annotation is treated as a write, as the MCP spec's defaults say. */
export function isReadOnly(tool: Pick<ServerTool, "annotations">): boolean {
	return tool.annotations?.readOnlyHint === true;
}

function namespacedName(server: string, tool: string): string {
	const safeServer = server.replace(/[^a-zA-Z0-9-]/g, "-");
	const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${safeServer}__${safeTool}`.slice(0, FN_NAME_MAX);
}

// JSON with object keys sorted at every depth, so the same tool hashes the same whatever order its
// server happened to serialize the keys in.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The hash a pin names (CUR-3985): everything in a listing that reaches the model or our policy —
 * name, description, input schema, annotations. A server that edits any of them after approval (the
 * "rug pull") produces a different hash.
 */
function toolSha256(tool: McpTool): string {
	const { name, description, inputSchema } = tool;
	const annotations = (tool as { annotations?: unknown }).annotations;
	return createHash("sha256").update(canonicalJson({ name, description, inputSchema, annotations })).digest("hex");
}

/**
 * The tools a pinned server may offer: those whose hash matches their pin. A changed tool and a tool
 * with no pin are both dropped and logged by name, since either is a tool nobody approved. A server
 * with no pins offers everything, as before pins existed.
 */
function applyPins(server: Pick<McpServerConfig, "name" | "pins">, tools: ServerTool[]): ServerTool[] {
	const pins = server.pins;
	if (!pins) return tools;
	const kept = tools.filter((t) => {
		const pin = pins[t.tool];
		if (pin === t.sha256) return true;
		logger.error(
			{ leg: "mcp-servers", server: server.name, tool: t.tool, sha256: t.sha256, pinned: pin ?? null },
			pin
				? "[mcp-servers] tool changed since it was pinned; left out until the pin is updated"
				: "[mcp-servers] tool has no pin on a pinned server; left out until it is pinned"
		);
		return false;
	});
	const listed = new Set(tools.map((t) => t.tool));
	for (const tool of Object.keys(pins)) {
		if (!listed.has(tool))
			logger.warn({ leg: "mcp-servers", server: server.name, tool }, "[mcp-servers] a pinned tool is no longer listed");
	}
	return kept;
}

function toServerTools(server: string, tools: McpTool[]): ServerTool[] {
	return tools.map((t) => {
		const fnName = namespacedName(server, t.name);
		const def = mcpToolToOpenAITool(t);
		const annotations = readAnnotations((t as { annotations?: unknown }).annotations);
		return {
			fnName,
			server,
			tool: t.name,
			sha256: toolSha256(t),
			...(annotations ? { annotations } : {}),
			definition: {
				type: "function",
				function: {
					name: fnName,
					description: `[${server}] ${def.function.description ?? t.name}`,
					parameters: def.function.parameters ?? { type: "object", properties: {} },
				},
			},
		};
	});
}

const cache = new Map<string, { at: number; key: string; tools: ServerTool[] }>();

/** Test seam: forget every cached listing. */
export function resetServerToolsCache(): void {
	cache.clear();
}

/**
 * Every server's tools, listed in parallel. A server that fails to answer contributes nothing and is
 * logged; two tools that sanitize to the same function name keep the first and log the second, since a
 * model calling an ambiguous name would run whichever we happened to map.
 */
export async function listServerTools(
	servers: McpServerConfig[],
	opts: { connect?: Connect; now?: () => number } = {}
): Promise<ServerTool[]> {
	const connect = opts.connect ?? connectServer;
	const now = opts.now ?? Date.now;
	const perServer = await Promise.all(
		servers.map(async (server) => {
			const key = `${server.url}|${Object.keys(server.headers).sort().join(",")}|${canonicalJson(server.pins ?? null)}`;
			const hit = cache.get(server.name);
			if (hit && hit.key === key && now() - hit.at < LIST_TTL_MS) return hit.tools;
			const started = now();
			let conn: McpConnection | undefined;
			try {
				conn = await connect(server, LIST_TIMEOUT_MS);
				const listed = toServerTools(server.name, conn.tools);
				const tools = applyPins(server, listed);
				cache.set(server.name, { at: now(), key, tools });
				// The hashes are logged on every listing so an operator can copy them into `pins`.
				logger.info(
					{
						leg: "mcp-servers",
						server: server.name,
						tools: tools.length,
						hashes: Object.fromEntries(listed.map((t) => [t.tool, t.sha256])),
						ms: now() - started,
					},
					"[mcp-servers] listed tools"
				);
				return tools;
			} catch (e) {
				logger.warn(
					{ leg: "mcp-servers", server: server.name, ms: now() - started, err: e instanceof Error ? e.message : String(e) },
					"[mcp-servers] listing failed; this server's tools are left out of the turn"
				);
				return [];
			} finally {
				await conn?.close();
			}
		})
	);
	const seen = new Set<string>();
	const out: ServerTool[] = [];
	for (const t of perServer.flat()) {
		if (seen.has(t.fnName)) {
			logger.warn({ leg: "mcp-servers", fnName: t.fnName }, "[mcp-servers] duplicate tool name; the later one is dropped");
			continue;
		}
		seen.add(t.fnName);
		out.push(t);
	}
	return out;
}
