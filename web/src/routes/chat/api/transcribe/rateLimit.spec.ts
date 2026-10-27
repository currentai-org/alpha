import { describe, it, expect, vi, beforeEach } from "vitest";

const configValues: Record<string, string> = { TRANSCRIPTION_MODEL: "whisper-test", HF_BILL_TO: "" };
vi.mock("$lib/chat/server/config", () => ({
	config: { get: (k: string) => configValues[k], ...configValues },
}));

vi.mock("$lib/chat/server/env/firstKey", () => ({ firstKey: vi.fn(() => "test-token") }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("$lib/chat/server/dictationMode", () => ({ dictationEnabled: vi.fn(() => true) }));

const rateLimitMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/chat/rateLimit", () => ({ enforceRequestRateLimits: rateLimitMock }));

const locals = { sessionId: "sess-1" } as App.Locals;
const clientAddress = "203.0.113.7";

const audioRequest = () =>
	new Request("http://localhost/chat/api/transcribe", {
		method: "POST",
		headers: { "content-type": "audio/webm" },
		body: new Uint8Array(10),
	});

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	rateLimitMock.mockReset().mockResolvedValue(undefined);
});

// This route has no requireAuth check at all today (dictation never required sign-in), but
// a Whisper call per upload was reachable with zero counter regardless — a guest always carries
// `locals.sessionId`, so the limiter needs no auth change to key on. These tests prove it now gates
// the route, before the fetch to the model. (CUR-832)
describe("POST /chat/api/transcribe — rate limiting (CUR-832)", () => {
	it("keys the limiter on the session id and the real client address, before the model fetch", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { POST } = await import("./+server");
		const res = await POST({
			request: audioRequest(),
			locals,
			getClientAddress: () => clientAddress,
		} as Parameters<typeof POST>[0]);
		expect(rateLimitMock).toHaveBeenCalledWith({ userId: "sess-1", clientAddress });
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("propagates a 429 from the limiter and never calls the model", async () => {
		rateLimitMock.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { POST } = await import("./+server");
		await expect(
			POST({
				request: audioRequest(),
				locals,
				getClientAddress: () => clientAddress,
			} as Parameters<typeof POST>[0])
		).rejects.toMatchObject({ status: 429 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// An upstream failure's body can name the HF user who owns our token, and the client prints the message of
// a 429. So the browser gets a fixed 502 carrying only the upstream status number (CUR-3522).
describe("POST /chat/api/transcribe — upstream failures (CUR-3522)", () => {
	async function postWithUpstream(status: number, body: string) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status }))
		);
		const { POST } = await import("./+server");
		return POST({
			request: audioRequest(),
			locals,
			getClientAddress: () => clientAddress,
		} as Parameters<typeof POST>[0]).then(
			() => expect.fail("an upstream failure must throw"),
			(e: { status: number; body: { message: string } }) => e
		);
	}

	it("answers 502 without the upstream body when the provider's 403 names the token owner", async () => {
		const leak = "insufficient permissions on behalf of user secret-token-owner";
		const e = await postWithUpstream(403, leak);
		expect(e.status).toBe(502);
		expect(e.body.message).not.toContain("secret-token-owner");
		expect(e.body.message).toContain("upstream 403");
	});

	it("turns an upstream 429 into a 502, so the client's rate-limit branch never prints provider text", async () => {
		const e = await postWithUpstream(429, "provider quota text");
		expect(e.status).toBe(502);
		expect(e.body.message).not.toContain("provider quota text");
	});
});
