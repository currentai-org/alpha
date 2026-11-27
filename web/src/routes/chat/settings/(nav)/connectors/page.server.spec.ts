import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Connectors exists only where the `mcp-servers` flag is on for the account, the
// same read the turn makes, and lists what a turn would offer: each server, its tools, which ones can
// change something, and the person's saved choice for each.
const flag = vi.hoisted(() => ({ on: false, google: false }));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string, fallback: () => boolean) =>
		key === "mcp-servers" ? flag.on : key === "google-connector" ? flag.google : fallback(),
	ensureFlagsPolled: async () => {},
}));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const findOne = vi.hoisted(() => vi.fn(async () => ({ mcpToolPolicies: { stub__set_setting: "allow" } })));
vi.mock("$lib/chat/server/database", () => ({ collections: { settings: { findOne } } }));
// The stub server is listed for a request that carries its fault; the fault gate itself is
// faultInjection.spec.ts's.
vi.mock("$lib/chat/server/textGeneration/faultInjection", () => ({
	resolveFaultInjection: async () => "mcp_stub_server",
}));

// A person's own servers. The store is faked; its userId scoping is in the query itself.
const store = vi.hoisted(() => ({
	rows: [] as { id: string; userId: string; name: string; url: string; credential: string | null; createdAt: Date }[],
	created: [] as { userId: string; name: string; url: string; credential: string | null }[],
	deleted: [] as [string, string][],
}));
vi.mock("$lib/chat/server/db/userMcpServers", () => ({
	listUserMcpServers: async (userId: string) => store.rows.filter((r) => r.userId === userId),
	createUserMcpServer: async (input: (typeof store.created)[number]) => {
		store.created.push(input);
		return { ...input, id: "new", createdAt: new Date(0) };
	},
	deleteUserMcpServer: async (userId: string, id: string) => {
		store.deleted.push([userId, id]);
		return store.rows.some((r) => r.userId === userId && r.id === id);
	},
}));
vi.mock("$lib/chat/server/config", () => ({ config: { BETTER_AUTH_SECRET: "page-test-secret" } }));

// A person's Google connection. The store is faked; the turn's token exchange is
// connectors/google.spec.ts's, so the server it would add is left out here.
const FULL_GRANT = "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly";
const google = vi.hoisted(() => ({ rows: new Map<string, { email: string; scopes: string }>(), deleted: [] as string[] }));
vi.mock("$lib/chat/server/db/userGoogleConnections", () => ({
	getUserGoogleConnection: async (userId: string) => google.rows.get(userId) ?? null,
	deleteUserGoogleConnection: async (userId: string) => {
		google.deleted.push(userId);
		return google.rows.delete(userId);
	},
}));
vi.mock("$lib/chat/server/connectors/google", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/connectors/google")>()),
	googleServerFor: async () => null,
}));

const { load, actions } = await import("./+page.server");
const { resetServerToolsCache } = await import("$lib/chat/server/mcp/serverTools");

type LoadEvent = Parameters<typeof load>[0];
const event = () =>
	({
		locals: { sessionId: "guest-session" },
		request: new Request("https://develop.aipotluck.org/chat/settings/connectors"),
	}) as unknown as LoadEvent;

afterEach(() => {
	resetServerToolsCache();
	findOne.mockClear();
});

describe("Settings → Connectors load", () => {
	it("is a 404 with mcp-servers off, and reads no settings", async () => {
		flag.on = false;
		await expect(load(event())).rejects.toMatchObject({ status: 404 });
		expect(findOne).not.toHaveBeenCalled();
	});

	it("with mcp-servers on, lists each tool marked read-only or not, with the visitor's saved choices", async () => {
		flag.on = true;
		const data = (await load(event())) as {
			servers: { name: string; host: string; tools: { fnName: string; readOnly: boolean }[] }[];
			policies: Record<string, string>;
		};
		expect(data.servers.map((s) => [s.name, s.host])).toEqual([["stub", "mcp-stub.e2e.invalid"]]);
		expect(Object.fromEntries(data.servers[0].tools.map((t) => [t.fnName, t.readOnly]))).toEqual({
			stub__get_setting: true,
			stub__set_setting: false,
			stub__get_admin_lock: true,
		});
		expect(data.policies).toEqual({ stub__set_setting: "allow" });
		// A guest's choices are read by session, like the rest of their settings.
		expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "guest-session" }));
	});
});

type ActionEvent = Parameters<NonNullable<typeof actions.add>>[0];
const SIGNED_IN = { user: { _id: { toString: () => "acct-1" } }, sessionId: "s1" };
const post = (locals: object, fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals,
		request: new Request("https://develop.aipotluck.org/chat/settings/connectors?/add", { method: "POST", body }),
	} as unknown as ActionEvent;
};

describe("adding and removing a server of your own", () => {
	afterEach(() => {
		store.rows = [];
		store.created = [];
		store.deleted = [];
	});

	it("refuses a guest, and stores nothing", async () => {
		flag.on = true;
		const res = await actions.add(post({ sessionId: "guest" }, { name: "notes", url: "https://notes.example.com/mcp" }));
		expect(res).toMatchObject({ status: 401 });
		expect(store.created).toEqual([]);
	});

	it("stores the server under the signed-in account with its token sealed, never in the clear", async () => {
		flag.on = true;
		const res = await actions.add(
			post(SIGNED_IN, { name: "Notes", url: "https://notes.example.com/mcp", token: "tok_secret_123" })
		);
		expect(res).toEqual({ added: "notes" });
		expect(store.created).toHaveLength(1);
		expect(store.created[0]).toMatchObject({ userId: "acct-1", name: "notes", url: "https://notes.example.com/mcp" });
		expect(store.created[0].credential).toMatch(/^v1\./);
		expect(store.created[0].credential).not.toContain("tok_secret_123");
	});

	it("refuses a bad address without echoing the token back", async () => {
		flag.on = true;
		const res = await actions.add(post(SIGNED_IN, { name: "notes", url: "http://notes.example.com", token: "tok_secret_123" }));
		expect(res).toMatchObject({ status: 400 });
		expect(JSON.stringify(res)).not.toContain("tok_secret_123");
		expect(store.created).toEqual([]);
	});

	it("removes by the signed-in account and id, so another account's id removes nothing", async () => {
		flag.on = true;
		store.rows = [{ id: "theirs", userId: "acct-2", name: "x", url: "https://x.example.com/mcp", credential: null, createdAt: new Date(0) }];
		const res = await actions.remove(post(SIGNED_IN, { id: "theirs" }));
		expect(store.deleted).toEqual([["acct-1", "theirs"]]);
		expect(res).toMatchObject({ status: 404 });
	});

	it("lists the person's server as theirs to remove, beside the operator's", async () => {
		flag.on = true;
		store.rows = [{ id: "r1", userId: "acct-1", name: "mine", url: "https://mcp-stub.e2e.invalid/mcp", credential: null, createdAt: new Date(0) }];
		const data = (await load({ ...event(), locals: SIGNED_IN } as unknown as LoadEvent)) as {
			signedIn: boolean;
			servers: { name: string; ownId: string | null; tools: unknown[] }[];
		};
		expect(data.signedIn).toBe(true);
		expect(data.servers.map((s) => [s.name, s.ownId])).toEqual([["mine", "r1"]]);
		expect(data.servers[0].tools.length).toBe(3);
	});
});

describe("Connect Google on Settings → Connectors", () => {
	beforeEach(() => {
		flag.on = false;
		flag.google = false;
		google.rows.clear();
		google.deleted = [];
	});

	it("opens with only google-connector on, without listing or offering the general servers", async () => {
		flag.google = true;
		const data = (await load(event())) as { mcpServers: boolean; servers: unknown[]; google: unknown };
		expect(data.mcpServers).toBe(false);
		expect(data.servers).toEqual([]);
		// The operator has not set the client up in this test's config, so the page says it is unavailable.
		expect(data.google).toEqual({ available: false, email: null, driveMissing: false });
	});

	it("offers a reconnect for Drive to a connection granted before Drive, and keeps it connected", async () => {
		flag.google = true;
		google.rows.set("acct-1", {
			email: "me@example.org",
			scopes: "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
		});
		const signedIn = { ...event(), locals: SIGNED_IN } as unknown as LoadEvent;
		const g = ((await load(signedIn)) as { google: { email: string | null; driveMissing: boolean } }).google;
		expect(g).toMatchObject({ email: "me@example.org", driveMissing: true });
		google.rows.set("acct-1", { email: "me@example.org", scopes: FULL_GRANT });
		expect(((await load(signedIn)) as { google: { driveMissing: boolean } }).google.driveMissing).toBe(false);
	});

	it("shows the connected account's Google email, and only theirs", async () => {
		flag.google = true;
		google.rows.set("acct-2", { email: "someone-else@example.org", scopes: FULL_GRANT });
		const signedIn = { ...event(), locals: SIGNED_IN } as unknown as LoadEvent;
		expect(((await load(signedIn)) as { google: { email: string | null } }).google.email).toBeNull();
		google.rows.set("acct-1", { email: "me@example.org", scopes: FULL_GRANT });
		expect(((await load(signedIn)) as { google: { email: string | null } }).google.email).toBe("me@example.org");
	});

	it("says nothing about Google while its flag is off (null, not a disconnected state)", async () => {
		flag.on = true;
		expect(((await load(event())) as { google: unknown }).google).toBeNull();
	});

	it("Disconnect removes the signed-in account's connection and no other, and refuses a guest", async () => {
		flag.google = true;
		google.rows.set("acct-1", { email: "me@example.org", scopes: FULL_GRANT });
		google.rows.set("acct-2", { email: "someone-else@example.org", scopes: FULL_GRANT });
		expect(await actions.disconnectGoogle(post({ sessionId: "guest" }, {}))).toMatchObject({ status: 401 });
		expect(google.deleted).toEqual([]);
		expect(await actions.disconnectGoogle(post(SIGNED_IN, {}))).toEqual({ googleDisconnected: true });
		expect(google.deleted).toEqual(["acct-1"]);
		expect([...google.rows.keys()]).toEqual(["acct-2"]);
	});

	it("Disconnect is a 404 while the flag is off", async () => {
		await expect(actions.disconnectGoogle(post(SIGNED_IN, {}))).rejects.toMatchObject({ status: 404 });
	});

	it("keeps the name google for Connect Google: a server of your own cannot take it", async () => {
		flag.on = true;
		const res = await actions.add(post(SIGNED_IN, { name: "google", url: "https://notes.example.com/mcp" }));
		expect(res).toMatchObject({ status: 400 });
		expect(store.created).toEqual([]);
	});
});
