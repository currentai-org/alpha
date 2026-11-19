/**
 * An unreachable local inference endpoint is the visitor's own device being off, and the settings page
 * polls it every ~10 s. The server logs the reachable-to-unreachable transition once and keeps repeats
 * out of the warn stream.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const warn = vi.fn();
const info = vi.fn();
const debug = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn, info, debug, error: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const fetchMock = vi.hoisted(() => ({ ok: false }));
vi.mock("$lib/chat/server/localEndpointFetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("./localEndpointFetch")>()),
	localEndpointFetch: async () =>
		fetchMock.ok
			? new Response(JSON.stringify({ data: [{ id: "llama3.2:latest" }] }), { status: 200 })
			: Promise.reject(new Error("fetch failed")),
}));

vi.mock("$lib/chat/server/localEndpointsGate", () => ({ localInferenceEndpointsEnabled: () => true }));
vi.mock("$lib/chat/server/db/localInferenceEndpoints", async (importOriginal) => ({
	...(await importOriginal<typeof import("./db/localInferenceEndpoints")>()),
	listLocalEndpointsForUserId: async () => [{ baseUrl: "http://192.168.1.20:11434/v1", headers: [] }],
}));

const { resolveLocalModelsForUser, checkLocalEndpointModels, __resetLocalModelsCacheForTests } = await import(
	"./localModels"
);
const locals = { user: { _id: "u1" } } as unknown as App.Locals;
const FAILED = "[localModels] Failed to fetch model list from local endpoint";
const URL_A = "http://192.168.1.20:11434/v1";

beforeEach(() => {
	warn.mockClear();
	info.mockClear();
	debug.mockClear();
	fetchMock.ok = false;
	__resetLocalModelsCacheForTests();
});

describe("a visitor's unreachable local endpoint", () => {
	it("logs once when an endpoint goes down, not on every poll, and never at warn", async () => {
		// A failed fetch caches nothing, so each poll below is a real second attempt.
		for (let i = 0; i < 5; i++) {
			await expect(resolveLocalModelsForUser(locals)).resolves.toEqual([]);
		}

		expect(warn).not.toHaveBeenCalled();
		expect(info.mock.calls.filter(([, m]) => m === FAILED)).toHaveLength(1);
		expect(debug.mock.calls.filter(([, m]) => m === FAILED)).toHaveLength(4);
	});

	it("logs again when the endpoint comes back and then goes down a second time", async () => {
		await resolveLocalModelsForUser(locals);
		// The settings page's health check reaches the device again.
		fetchMock.ok = true;
		await expect(checkLocalEndpointModels(URL_A)).resolves.toEqual(["llama3.2:latest"]);

		// Past the 30 s cache TTL, with the device off again.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
		fetchMock.ok = false;
		await resolveLocalModelsForUser(locals);
		vi.restoreAllMocks();

		expect(info.mock.calls.filter(([, m]) => m === FAILED)).toHaveLength(2);
	});
});
