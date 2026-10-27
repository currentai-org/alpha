// Operator-configured MCP servers (CUR-3026). `MCP_SERVERS` is a JSON list of
// `{ name, url, headers: { HeaderName: "ENV_VAR_NAME" }, pins?: { toolName: "<sha256>" } }`: the JSON names which env var holds each
// header's value and never the value itself, so a secret lives in Doppler like every other secret and
// the list can be read in a log or a ticket without leaking one.
//
// This list is the flag-gated source of MCP tools, offered through the tool loop (CUR-3989).
import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { isValidUrl, ssrfSafeFetch } from "$lib/chat/server/urlSafety";

/** PostHog flag key. Owner: chat. Gates whether configured servers' tools are offered at all. */
export const MCP_SERVERS_FLAG = "mcp-servers";

/** Whether this request's account gets the configured servers' tools. Off by default: a feature
 *  that can change a setting on someone's behalf defaults closed. */
export function mcpServersEnabled(): boolean {
	return flagEnabledOr(MCP_SERVERS_FLAG, () => false);
}

export type McpServerConfig = {
	/** Short, unique, and the prefix of every tool name this server contributes. */
	name: string;
	url: string;
	/** Header name to resolved value. Sent to this server's own origin and nowhere else. */
	headers: Record<string, string>;
	/** The server's origin, the only one its headers may reach. */
	origin: string;
	/** The fetch this server's transport uses. Origin-scoped (originScopedFetch). */
	fetch: FetchLike;
	/** Tool name to the SHA-256 the operator approved (CUR-3985). When set, only tools whose current
	 *  listing hashes to its pin are offered; see `toolSha256` in serverTools.ts. */
	pins?: Record<string, string>;
	/** This server's MCP progress on a call means it is waiting for a free sandbox (agent-service's (CUR-4584)
	 *  /mcp/ on a full host), so the live line says so while the call is pending. */
	progressIsSandboxWait?: boolean;
	/** Most one call may take, past the SDK's 60 s default. The sandbox may wait about a minute for a slot. */
	callTimeoutMs?: number;
};

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

// Lower-case, starts with a letter, short: it becomes the `server__` prefix of a function name, and
// OpenAI-compatible hosts cap a function name at 64 characters of [a-zA-Z0-9_-].
export const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
// RFC 9110 token characters, the only legal header-name spelling.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// An env var name. A value that looks like a secret ("Bearer abc…") fails this, which is the point.
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Wraps `base` so a request, and every redirect hop after it, may only go to `origin`. A hop to any
 * other origin throws before anything is sent, so the server's headers never reach a host the operator
 * did not name. Redirects are followed here with `redirect: "manual"` on each hop, because a fetch that
 * follows on its own would carry the headers across before this code could look at the target.
 */
export function originScopedFetch(origin: string, base: FetchLike = ssrfSafeFetch): FetchLike {
	return async (input, init) => {
		let url = new URL(String(input));
		let current: RequestInit | undefined = init;
		for (let hop = 0; ; hop++) {
			if (url.origin !== origin) {
				throw new Error(`[mcp-servers] refused a request to ${url.origin}: this server's headers go only to ${origin}`);
			}
			const res = await base(url, { ...current, redirect: "manual" });
			if (!REDIRECTS.has(res.status)) return res;
			if (hop >= MAX_REDIRECTS) throw new Error("[mcp-servers] too many redirects");
			const location = res.headers.get("location");
			if (!location) throw new Error("[mcp-servers] redirect without a Location header");
			url = new URL(location, url);
			// Per the fetch spec: 303, and 301/302 on a POST, become a bodiless GET.
			const method = (current?.method ?? "GET").toUpperCase();
			if (res.status === 303 || ([301, 302].includes(res.status) && method === "POST")) {
				current = { ...current, method: "GET", body: undefined };
			}
		}
	};
}

type ParseDeps = {
	env?: (name: string) => string | undefined;
	validUrl?: (url: string) => boolean;
	baseFetch?: FetchLike;
};

/**
 * Parses `raw` into usable servers. A malformed list yields none; a bad entry is dropped on its own.
 * Every drop is logged loudly by reason, because an operator who set the list expects the tools and a
 * quiet drop reads exactly like "the model chose not to call them".
 */
export function parseMcpServers(raw: string | undefined, deps: ParseDeps = {}): McpServerConfig[] {
	const text = raw?.trim();
	if (!text) return [];
	const env = deps.env ?? ((n: string) => (Reflect.get(config, n) as string | undefined) ?? process.env[n]);
	const validUrl = deps.validUrl ?? isValidUrl;
	let list: unknown;
	try {
		list = JSON.parse(text);
	} catch {
		logger.error({ leg: "mcp-servers" }, "[mcp-servers] MCP_SERVERS is not valid JSON; no servers are offered");
		return [];
	}
	if (!Array.isArray(list)) {
		logger.error({ leg: "mcp-servers" }, "[mcp-servers] MCP_SERVERS must be a JSON list; no servers are offered");
		return [];
	}
	const out: McpServerConfig[] = [];
	const seen = new Set<string>();
	list.forEach((entry, index) => {
		const drop = (reason: string) =>
			logger.error({ leg: "mcp-servers", index, reason }, "[mcp-servers] server entry dropped");
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return drop("not an object");
		const { name, url, headers, pins } = entry as Record<string, unknown>;
		if (typeof name !== "string" || !NAME_RE.test(name)) return drop("name must match [a-z][a-z0-9-]{0,23}");
		if (seen.has(name)) return drop(`duplicate name ${name}`);
		if (typeof url !== "string" || !validUrl(url)) return drop(`${name}: url is not a safe https URL`);
		const resolved: Record<string, string> = {};
		if (headers !== undefined) {
			if (!headers || typeof headers !== "object" || Array.isArray(headers)) return drop(`${name}: headers must be an object`);
			for (const [header, envName] of Object.entries(headers as Record<string, unknown>)) {
				if (!HEADER_NAME_RE.test(header)) return drop(`${name}: bad header name`);
				if (typeof envName !== "string" || !ENV_NAME_RE.test(envName))
					return drop(`${name}: header ${header} must name an env var, not carry a value`);
				const value = env(envName)?.trim();
				if (!value) return drop(`${name}: env var ${envName} for header ${header} is unset`);
				resolved[header] = value;
			}
		}
		let pinned: Record<string, string> | undefined;
		if (pins !== undefined) {
			// A malformed pin drops the whole server rather than the one tool: an operator who pinned
			// meant "nothing unapproved", and offering the server unpinned would quietly undo that.
			if (!pins || typeof pins !== "object" || Array.isArray(pins)) return drop(`${name}: pins must be an object`);
			pinned = {};
			for (const [tool, sha] of Object.entries(pins as Record<string, unknown>)) {
				if (typeof sha !== "string" || !SHA256_RE.test(sha))
					return drop(`${name}: pin for ${tool} must be a lower-case hex SHA-256`);
				pinned[tool] = sha;
			}
		}
		const origin = new URL(url).origin;
		seen.add(name);
		out.push({
			name,
			url,
			headers: resolved,
			origin,
			fetch: originScopedFetch(origin, deps.baseFetch),
			...(pinned ? { pins: pinned } : {}),
		});
	});
	return out;
}

let cached: { raw: string | undefined; servers: McpServerConfig[] } | undefined;

/** The deployment's configured servers, parsed once per distinct `MCP_SERVERS` value. */
export function configuredMcpServers(): McpServerConfig[] {
	const raw = Reflect.get(config, "MCP_SERVERS") as string | undefined;
	if (cached && cached.raw === raw) return cached.servers;
	cached = { raw, servers: parseMcpServers(raw) };
	return cached.servers;
}
