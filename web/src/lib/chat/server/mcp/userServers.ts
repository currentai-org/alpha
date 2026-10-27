// MCP servers a person added themselves in Settings → Connectors (CUR-4016), beside the operator's
// MCP_SERVERS list (servers.ts). Signed-in accounts only: a server and its token belong to an account,
// and a guest session is too short-lived to hold either.
//
// The token is sealed at rest (sealedSecret.ts, under an info string of its own) and opened only to
// build the turn's server config, where it rides as `Authorization: Bearer …` through the same
// origin-scoped fetch an operator's header gets, so no redirect can carry it to another host.
import { logger } from "$lib/chat/server/logger";
import { isValidUrlStrict, ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import { credentialSecret, open, seal, SealedSecretError } from "$lib/chat/server/storage/locations/sealedSecret";
import { listUserMcpServers, type UserMcpServerRow } from "$lib/chat/server/db/userMcpServers";
import type { FaultInjectionName } from "$lib/chat/server/textGeneration/faultInjection";
import { NAME_RE, originScopedFetch, type FetchLike, type McpServerConfig } from "./servers";
import { STUB_URL, stubMcpFetch } from "./e2eStub";

/** HKDF info for these tokens, so a sealed storage-location credential cannot be opened as one. */
const SEAL_INFO = "aipotluck/user-mcp-server-credential/v1";
/** A person's own servers, at most. Each costs a tools/list on every turn. */
const MAX_USER_MCP_SERVERS = 5;
const MAX_TOKEN_CHARS = 4096;
// A token is one header value: printable ASCII with no spaces, so it cannot smuggle a second header.
const TOKEN_RE = /^[\x21-\x7e]+$/;

export type NewServerInput = { name: string; url: string; token: string };
export type NewServerCheck = { ok: true; name: string; url: string; token: string | null } | { ok: false; error: string };

/** Checks what the add form sent, against the names already in use for this person. */
export function checkNewServer(input: NewServerInput, takenNames: string[], ownCount: number): NewServerCheck {
	const name = input.name.trim().toLowerCase();
	const url = input.url.trim();
	const token = input.token.trim();
	if (ownCount >= MAX_USER_MCP_SERVERS) {
		return { ok: false, error: `You can add up to ${MAX_USER_MCP_SERVERS} servers. Remove one to add another.` };
	}
	if (!NAME_RE.test(name)) {
		return {
			ok: false,
			error: "Use a short name: lower-case letters, digits and hyphens, starting with a letter, up to 24 characters.",
		};
	}
	if (takenNames.includes(name)) return { ok: false, error: `A server named ${name} is already connected.` };
	// Strict: a person's URL may not name a private or cluster-internal address (10/8 included).
	if (!isValidUrlStrict(url)) return { ok: false, error: "Use a public https:// address for the server." };
	if (token && (token.length > MAX_TOKEN_CHARS || !TOKEN_RE.test(token))) {
		return { ok: false, error: "That token has spaces or characters a token can't have." };
	}
	return { ok: true, name, url, token: token || null };
}

export function sealServerToken(token: string, secret = credentialSecret()): string {
	return seal(token, secret, SEAL_INFO);
}

type ConfigDeps = { secret?: string; faultInjection?: FaultInjectionName | null; baseFetch?: FetchLike };

/**
 * The person's rows as servers a turn can reach. A token that no longer opens (the sealing secret
 * rotated) drops that server with an error log rather than sending it without its token.
 */
export function userServerConfigs(rows: UserMcpServerRow[], deps: ConfigDeps = {}): McpServerConfig[] {
	const out: McpServerConfig[] = [];
	for (const row of rows) {
		let headers: Record<string, string> = {};
		if (row.credential) {
			try {
				headers = { Authorization: `Bearer ${open(row.credential, deps.secret ?? credentialSecret(), SEAL_INFO)}` };
			} catch (e) {
				if (!(e instanceof SealedSecretError)) throw e;
				logger.error({ leg: "mcp-servers", server: row.name }, "[mcp-servers] a person's server token no longer opens; server left out");
				continue;
			}
		}
		const origin = new URL(row.url).origin;
		// The e2e stub answers in-process, and only while its fault is on (e2eStub.ts).
		const base =
			deps.faultInjection === "mcp_stub_server" && row.url === STUB_URL ? stubMcpFetch : (deps.baseFetch ?? ssrfStrictFetch);
		out.push({ name: row.name, url: row.url, headers, origin, fetch: originScopedFetch(origin, base) });
	}
	return out;
}

/** The signed-in person's own servers for this request, or none for a guest or on a failed read. */
export async function userMcpServersFor(
	locals: App.Locals | undefined,
	faultInjection: FaultInjectionName | null | undefined,
	list: (userId: string) => Promise<UserMcpServerRow[]> = listUserMcpServers
): Promise<McpServerConfig[]> {
	const userId = locals?.user?._id?.toString();
	if (!userId) return [];
	try {
		return userServerConfigs(await list(userId), { faultInjection });
	} catch (e) {
		logger.warn(
			{ leg: "mcp-servers", err: e instanceof Error ? e.message : String(e) },
			"[mcp-servers] could not read the person's own servers; only the configured ones are offered"
		);
		return [];
	}
}
