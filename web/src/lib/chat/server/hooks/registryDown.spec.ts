// A model provider that cannot be reached at boot leaves the model registry empty. The handle hook's
// registry gate must not turn that into a 500 on every page: a page GET carries on (the layout load
// then reports `modelsUnavailable` and the chat says so), the status banner's endpoint keeps
// answering, and only the surfaces that need a model are refused, with a 503 whose body carries the
// copy the chat shows.
//
// "Carries on" is observed as the request reaching authenticateRequest, the next step after the gate:
// the mock throws there so the rest of the pipeline (database, flags) stays out of this spec.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ERROR_MESSAGES } from "$lib/chat/stores/errors";

const H = vi.hoisted(() => ({
	ready: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("$lib/chat/server/database", () => ({ collections: {} }));
vi.mock("$lib/chat/server/auth", () => ({
	authenticateRequest: vi.fn(async () => {
		throw new Error("reached authenticateRequest");
	}),
	loginEnabled: () => false,
	refreshSessionCookie: vi.fn(),
}));
vi.mock("$lib/chat/server/models", () => ({ ensureModelsReady: H.ready }));
vi.mock("$lib/chat/server/config", () => ({
	config: {
		checkForUpdates: vi.fn(async () => {}),
		AUTOMATIC_LOGIN: "false",
		PUBLIC_ORIGIN: "https://chat.example.test",
		PUBLIC_GOOGLE_ANALYTICS_ID: "",
	},
	ready: Promise.resolve(),
}));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { error: vi.fn(), warn: H.warn, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("$app/env", () => ({ dev: false, building: false }));

const resolve = vi.fn(async () => new Response("resolved", { status: 200 }));

beforeEach(() => {
	vi.clearAllMocks();
	H.ready.mockReset().mockRejectedValue(new Error("connect ECONNREFUSED provider.example.test:443"));
});

async function throughHook(
	pathname: string,
	init: { method?: string; accept?: string; body?: string } = {}
): Promise<Response> {
	const { handleRequest } = await import("$lib/chat/server/hooks/handle");
	const url = new URL(`https://chat.example.test${pathname}`);
	const headers: Record<string, string> = {};
	if (init.accept) headers.accept = init.accept;
	const request = new Request(url, { method: init.method ?? "GET", headers, body: init.body });
	const event = { url, request, locals: {}, route: { id: null }, params: {} };
	return handleRequest({ event, resolve } as never);
}

describe("the registry gate while the model provider is unreachable", () => {
	it("a page GET carries on past the gate instead of failing", async () => {
		await expect(throughHook("/chat/", { accept: "text/html" })).rejects.toThrow(
			"reached authenticateRequest"
		);
		expect(H.ready).toHaveBeenCalled();
	});

	// curl and a monitor send `*/*`, and a client-side navigation fetches __data.json: neither may 500.
	it.each(["/chat/", "/chat/__data.json"])("a GET of %s with accept */* carries on too", async (path) => {
		await expect(throughHook(path, { accept: "*/*" })).rejects.toThrow("reached authenticateRequest");
	});

	it("warns once for an outage, not once per page view", async () => {
		// A fresh hook module, so an earlier test's outage does not count as this one's.
		vi.resetModules();
		const outageWarnings = () =>
			H.warn.mock.calls.filter(([, msg]) => String(msg).includes("serving pages without models"));

		await expect(throughHook("/chat/", { accept: "text/html" })).rejects.toThrow();
		await expect(throughHook("/chat/", { accept: "text/html" })).rejects.toThrow();

		expect(outageWarnings()).toHaveLength(1);
	});

	it("the status banner's endpoint does not wait on the registry", async () => {
		await expect(throughHook("/chat/api/status")).rejects.toThrow("reached authenticateRequest");
		expect(H.ready).not.toHaveBeenCalled();
	});

	it("a chat POST gets a 503 JSON saying the model is unavailable, and goes no further", async () => {
		const auth = await import("$lib/chat/server/auth");

		const res = await throughHook("/chat/conversation", {
			method: "POST",
			body: JSON.stringify({ model: "any" }),
		});

		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toBe("application/json");
		const body = await res.json();
		expect(body.error).toBe(ERROR_MESSAGES.modelUnavailable);
		// The chat client reads `message` off a refused request (messageUpdates.ts, createConversation.ts).
		expect(body.message).toBe(ERROR_MESSAGES.modelUnavailable);
		expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|provider\.example/);
		expect(auth.authenticateRequest).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it("an API GET that needs a model gets the same 503", async () => {
		const res = await throughHook("/chat/api/v2/models");

		expect(res.status).toBe(503);
		expect((await res.json()).error).toBe(ERROR_MESSAGES.modelUnavailable);
	});
});
