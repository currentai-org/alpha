// A person's connectors on an agent turn. What has to hold: each turn's list comes from its own signed-in
// account and no other, so one who never connected Google sends none even when another account has; a
// guest sends none; what goes out is the connector's address and a short-lived access token, never the
// refresh token; and the read-only rule the gateway enforces hashes a tool as chat pins it.
import { describe, expect, it, vi } from "vitest";
import * as oidc from "openid-client";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/db/userGoogleConnections", () => ({ getUserGoogleConnection: async () => null }));

const { agentConnectorsFor } = await import("./agentConnectors");
const { googleServerFor, sealRefreshToken } = await import("$lib/chat/server/connectors/google");
const { toolSha256 } = await import("$lib/chat/server/mcp/serverTools");
type Row = import("$lib/chat/server/db/userGoogleConnections").UserGoogleConnectionRow;

const SECRET = "b".repeat(64);
const app = {
	clientId: "client-1.apps.googleusercontent.com",
	clientSecret: "client-secret",
	redirectUri: "http://localhost:3000/chat/api/connectors/google/callback",
	connectorUrl: "http://google:8000/mcp",
};
const locals = (id?: string) => ({ user: id ? { _id: { toString: () => id } } : undefined }) as App.Locals;

/** Google's metadata offline; each refresh hands out an access token naming whose refresh token it was. */
function offline() {
	const cfg = new oidc.Configuration(
		{ issuer: "https://accounts.google.com", token_endpoint: "https://oauth2.googleapis.com/token" },
		app.clientId,
		app.clientSecret
	);
	return async () => cfg;
}

/** Only account B has connected Google. */
const rows = new Map<string, Row>([
	[
		"account-b",
		{
			userId: "account-b",
			email: "b@example.org",
			scopes: "",
			credential: sealRefreshToken("refresh-of-b", SECRET),
			createdAt: new Date(),
		},
	],
]);

function deps() {
	const reads: string[] = [];
	const googleFor: typeof googleServerFor = (l, _d, fault) =>
		googleServerFor(
			l,
			{
				app,
				secret: SECRET,
				discover: offline(),
				read: async (userId) => {
					reads.push(userId);
					return rows.get(userId) ?? null;
				},
				refresh: async (_cfg, refreshToken) =>
					({ access_token: `access-for-${refreshToken}`, token_type: "bearer", expires_in: 3600 }) as oidc.TokenEndpointResponse,
			},
			fault
		);
	return { reads, googleFor };
}

describe("agent-turn connectors", () => {
	it("sends no Google entry for an account that never connected, even when another account has", async () => {
		const d = deps();
		expect(await agentConnectorsFor(locals("account-a"), { googleFor: d.googleFor })).toEqual([]);
		expect(d.reads).toEqual(["account-a"]);
	});

	it("sends the connector's address and an access token for the account that connected, never its refresh token", async () => {
		const d = deps();
		const got = await agentConnectorsFor(locals("account-b"), { googleFor: d.googleFor });
		expect(got).toEqual([
			{ name: "google", url: "http://google:8000/mcp", headers: { Authorization: "Bearer access-for-refresh-of-b" } },
		]);
		expect(d.reads).toEqual(["account-b"]);
		expect(JSON.stringify(got)).not.toContain(rows.get("account-b")?.credential);
	});

	it("sends nothing for a guest, without reading any account's connection", async () => {
		const d = deps();
		expect(await agentConnectorsFor(locals(undefined), { googleFor: d.googleFor })).toEqual([]);
		expect(d.reads).toEqual([]);
	});

	it("asks for Google's stand-in only under the google_connector_stub fault", async () => {
		const seen: unknown[] = [];
		const googleFor: typeof googleServerFor = async (_l, _d, fault) => {
			seen.push(fault);
			return null;
		};
		await agentConnectorsFor(locals("account-b"), { googleFor });
		await agentConnectorsFor(locals("account-b"), { googleFor, googleStub: true });
		expect(seen).toEqual([null, "google_connector_stub"]);
	});

	it("hashes a tool to the value the gateway pins it by (agent-service test_connector_relay.py)", () => {
		const tool = {
			name: "search_gmail_messages",
			description: "Search Gmail.",
			inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
			annotations: { readOnlyHint: true },
		};
		expect(toolSha256(tool)).toBe("436be1094d367548f572c7ec876eb584cc73ea4057b4d927e44d0d5eb3a37c09");
	});
});
