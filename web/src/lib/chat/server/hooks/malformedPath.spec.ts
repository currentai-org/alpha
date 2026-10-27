// A path whose percent-encoding cannot be decoded is answered 400 by the handle hook BEFORE any auth or
// login logic (CUR-2117, ported from upstream chat-ui). Scanner traffic such as
// `/chat/..%c0%af..%c0%afetc/passwd` would otherwise reach the OAuth branch, whose thrown redirect
// becomes an unhandled rejection that kills the process. SvelteKit only produces its own 400 inside resolve(), after
// the hook has run, so the hook has to refuse these itself. AUTOMATIC_LOGIN is "true" here so the login
// branch is armed and a missed guard is observable.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/database", () => ({ collections: {} }));
vi.mock("$lib/chat/server/auth", () => ({
	authenticateRequest: vi.fn(async () => {
		throw new Error("reached authenticateRequest");
	}),
	loginEnabled: () => true,
	refreshSessionCookie: vi.fn(),
}));
vi.mock("$lib/chat/server/models", () => ({ ensureModelsReady: vi.fn(async () => {}) }));
vi.mock("$lib/chat/server/config", () => ({
	config: {
		checkForUpdates: vi.fn(async () => {}),
		AUTOMATIC_LOGIN: "true",
		PUBLIC_ORIGIN: "https://www.aipotluck.org",
		PUBLIC_GOOGLE_ANALYTICS_ID: "",
	},
	ready: Promise.resolve(),
}));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("$app/environment", () => ({ dev: false, building: false }));

const resolve = vi.fn(async () => new Response("resolved", { status: 200 }));

beforeEach(() => {
	vi.clearAllMocks();
});

async function throughHook(pathname: string): Promise<Response> {
	const { handleRequest } = await import("$lib/chat/server/hooks/handle");
	const url = new URL(`https://www.aipotluck.org${pathname}`);
	const request = new Request(url, { method: "GET" });
	const event = { url, request, locals: {}, route: { id: null }, params: {} };
	return handleRequest({ event, resolve } as never);
}

describe("the handle hook refuses a malformed percent-encoded path before any auth logic (CUR-2117)", () => {
	it.each([
		"/chat/..%c0%af..%c0%afetc/passwd",
		"/chat/WEB-INF/web.xml%C0%80.jsp",
		"/chat/%E0%A4%A",
	])("%s answers 400 without reaching auth, the login redirect or the route", async (path) => {
		const res = await throughHook(path);
		const auth = await import("$lib/chat/server/auth");

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Malformed URI");
		expect(auth.authenticateRequest).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it("lets a well-formed percent-encoded path through to auth", async () => {
		await expect(throughHook("/chat/conversation/abc%20def")).rejects.toThrow("reached authenticateRequest");
	});
});
