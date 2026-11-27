// The `google_connector_stub` fault (googleE2eStub.ts). What has to hold: only that fault arms the
// stand-ins; under it a connect runs the real openid-client exchange to a grant with Drive, the sealed
// refresh token refreshes to a bearer, and that bearer lists and calls the read-only Drive tools through
// the real MCP client; and the stand-in connector refuses any other bearer, so a listed tool means the
// refresh really ran. The scenario google-drive-connect.spec.ts drives the same path from a browser.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/db/userGoogleConnections", () => ({ getUserGoogleConnection: async () => null }));

const { finishConnect, googleFaultDeps, googleServerFor, googleGrantLacksDrive, sealRefreshToken, startConnect } =
	await import("./google");
const { stubGoogleMcpFetch } = await import("./googleE2eStub");
const { connectServer, listServerTools, resetServerToolsCache } = await import("$lib/chat/server/mcp/serverTools");
type Row = import("$lib/chat/server/db/userGoogleConnections").UserGoogleConnectionRow;

afterEach(() => resetServerToolsCache());

// What googleE2eStub.ts stands in with, written out here so a change to it shows up as a failure.
const STUB_GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts-google.e2e.invalid/o/oauth2/v2/auth";
const STUB_GOOGLE_EMAIL = "drive-e2e@example.org";
const STUB_DRIVE_FACT = "plot 7 waters on Thursdays";

const SECRET = "b".repeat(64);
const app = {
	clientId: "e2e-client.apps.googleusercontent.com",
	clientSecret: "e2e-client-secret",
	redirectUri: "http://localhost:4173/chat/api/connectors/google/callback",
	connectorUrl: "https://google-connector.e2e.invalid/mcp",
};
const locals = (id: string) => ({ user: { _id: { toString: () => id } } }) as App.Locals;

/** The consent screen's answer: back to the redirect URI with a code and the state it was sent. */
function consentAnswer(consent: URL): URL {
	const back = new URL(consent.searchParams.get("redirect_uri") ?? "");
	back.searchParams.set("code", "e2e-code");
	back.searchParams.set("state", consent.searchParams.get("state") ?? "");
	return back;
}

describe("google_connector_stub", () => {
	it("arms the stand-ins only when that fault is named: no fault, or another one, keeps the real Google", () => {
		expect(googleFaultDeps(null)).toEqual({});
		expect(googleFaultDeps(undefined)).toEqual({});
		expect(googleFaultDeps("mcp_stub_server")).toEqual({});
		const armed = googleFaultDeps("google_connector_stub");
		expect(armed.discover).toBeTypeOf("function");
		expect(armed.baseFetch).toBe(stubGoogleMcpFetch);
	});

	it("connects through the real code exchange to a grant that includes Drive, then refreshes and calls a Drive tool", async () => {
		const deps = googleFaultDeps("google_connector_stub");
		const { url: consent, state, verifier } = await startConnect(app, deps);
		expect(consent.origin + consent.pathname).toBe(STUB_GOOGLE_AUTHORIZATION_ENDPOINT);

		const grant = await finishConnect(app, consentAnswer(consent), { state, verifier }, deps);
		expect(grant.email).toBe(STUB_GOOGLE_EMAIL);
		expect(googleGrantLacksDrive(grant.scopes)).toBe(false);

		const row: Row = {
			userId: "u-stub",
			email: grant.email,
			scopes: grant.scopes,
			credential: sealRefreshToken(grant.refreshToken, SECRET),
			createdAt: new Date(),
		};
		const server = await googleServerFor(locals("u-stub"), { app, secret: SECRET, read: async () => row }, "google_connector_stub");
		expect(server).toMatchObject({ name: "google", url: app.connectorUrl });

		const tools = await listServerTools([server!]);
		expect(tools.map((t) => t.tool).sort()).toEqual(["get_drive_file_content", "search_drive_files"]);
		expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

		const conn = await connectServer(server!, 5_000);
		try {
			const result = await conn.call("search_drive_files", { query: "allotment rota" });
			expect(result).toEqual({ kind: "text", text: expect.stringContaining(STUB_DRIVE_FACT) });
		} finally {
			await conn.close();
		}
	});

	it("refuses a callback whose state is not the one the connect minted, as the real exchange does", async () => {
		const deps = googleFaultDeps("google_connector_stub");
		const { url: consent, verifier } = await startConnect(app, deps);
		await expect(finishConnect(app, consentAnswer(consent), { state: "forged", verifier }, deps)).rejects.toThrow();
	});

	it("the stand-in connector answers 401 to a bearer its refresh did not hand out, so a listed tool proves the refresh ran", async () => {
		const res = await stubGoogleMcpFetch(app.connectorUrl, {
			method: "POST",
			headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(401);
	});
});
