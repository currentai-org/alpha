import { describe, it, expect, vi, beforeEach } from "vitest";

// The debug config endpoint answered to locals.isAdmin alone. It now takes the admin role's
// config:read grant, like every /chat/admin route (CUR-3992). (CUR-1878)

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
vi.mock("$lib/chat/server/models", () => ({ models: [{ id: "m" }] }));

const noCookies = { get: () => undefined } as unknown as import("@sveltejs/kit").Cookies;
const sessionAdmin = { isAdmin: true, sessionId: "s" } as unknown as App.Locals;
const withRole = (role: string) => ({ isAdmin: false, sessionId: "s", user: { _id: "u", role } }) as unknown as App.Locals;

async function call(locals: App.Locals) {
	const { GET } = await import("./+server");
	return GET({ locals, cookies: noCookies } as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.OPENAI_BASE_URL = "https://gateway.example";
});

describe("GET /chat/api/v2/debug/config admin gate (CUR-1878, CUR-3992)", () => {
	it("refuses a session carrying only the legacy isAdmin flag (401)", async () => {
		await expect(call(sessionAdmin)).rejects.toMatchObject({ status: 401 });
	});

	it("serves the admin role and refuses an editor, whose role has no config:read (403)", async () => {
		const ok = await call(withRole("admin"));
		expect(ok.status).toBe(200);
		await expect(call(withRole("editor"))).rejects.toMatchObject({ status: 403 });
	});
});
