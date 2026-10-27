import { describe, it, expect, vi, beforeEach } from "vitest";

// api/fetch-url had no limit, used the SSRF guard that allows cluster-internal ranges, and
// answered `public, max-age=3600`. These pin each of the three fixes at the route. (CUR-3191)
vi.mock("$lib/chat/server/logger.js", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
	securityLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const ssrfStrictFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock("$lib/chat/server/urlSafety", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/urlSafety")>()),
	ssrfStrictFetch: (url: string, init?: RequestInit) => ssrfStrictFetch(url, init),
}));

const fetchUrlAllowed = vi.fn<(opts: { userId: string; clientAddress: string }) => Promise<string>>();
vi.mock("$lib/chat/server/db/fetchUrlRate", () => ({
	fetchUrlAllowed: (opts: { userId: string; clientAddress: string }) => fetchUrlAllowed(opts),
}));

vi.mock("$lib/chat/constants/uploadLimits", () => ({
	CHAT_ATTACHMENTS_MAX_BYTES: 16,
	chatAttachmentsTooLargeMessage: () => "too large",
}));

import { GET } from "./+server";

type Event = Parameters<typeof GET>[0];
const call = (target: string | null, locals: Partial<App.Locals> = {}) =>
	GET({
		url: new URL(
			`http://localhost/chat/api/fetch-url${target === null ? "" : `?${new URLSearchParams({ url: target })}`}`
		),
		locals: { sessionId: "sess-1", isAdmin: false, ...locals },
		getClientAddress: () => "203.0.113.7",
	} as unknown as Event);

/** A body with no Content-Length, streamed in chunks, so only a streaming cap can catch its size. */
const streamed = (chunks: string[]) =>
	new Response(
		new ReadableStream({
			start(c) {
				for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
				c.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/plain" } }
	);

beforeEach(() => {
	ssrfStrictFetch.mockReset().mockResolvedValue(new Response("hello", { status: 200 }));
	fetchUrlAllowed.mockReset().mockResolvedValue("ok");
});

describe("GET /chat/api/fetch-url (CUR-3191)", () => {
	it("refuses a guest whose session was minted by this very request, before counting or fetching", async () => {
		await expect(call("https://example.com/a.txt", { guestSessionMinted: true })).rejects.toMatchObject({
			status: 401,
		});
		expect(fetchUrlAllowed).not.toHaveBeenCalled();
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
	});

	it("serves a guest holding a session the server already issued, keyed on that session", async () => {
		const res = await call("https://example.com/a.txt");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello");
		expect(fetchUrlAllowed).toHaveBeenCalledWith({ userId: "sess-1", clientAddress: "203.0.113.7" });
	});

	it("answers private, no-store so no shared cache keeps one visitor's fetch", async () => {
		const res = await call("https://example.com/a.txt");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("refuses a cluster-internal address (10/8) that the default guard allowed, without fetching", async () => {
		await expect(call("https://10.0.0.5/admin")).rejects.toMatchObject({ status: 400 });
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
	});

	it("refuses a redirect into a cluster-internal address", async () => {
		ssrfStrictFetch.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: "https://10.1.2.3/secret" } })
		);
		await expect(call("https://example.com/r")).rejects.toMatchObject({ status: 403 });
		expect(ssrfStrictFetch).toHaveBeenCalledTimes(1);
	});

	it("returns 429 with the per-session message when the session is over its limit", async () => {
		fetchUrlAllowed.mockResolvedValue("session");
		await expect(call("https://example.com/a.txt")).rejects.toMatchObject({
			status: 429,
			body: { message: expect.stringMatching(/last minute/) },
		});
		expect(ssrfStrictFetch).not.toHaveBeenCalled();
	});

	it("returns 429 naming a shared network when the IP backstop is reached", async () => {
		fetchUrlAllowed.mockResolvedValue("ip");
		await expect(call("https://example.com/a.txt")).rejects.toMatchObject({
			status: 429,
			body: { message: expect.stringMatching(/your network/) },
		});
	});

	it("cuts off a body past the cap as it streams, even with no Content-Length", async () => {
		ssrfStrictFetch.mockResolvedValueOnce(streamed(["0123456789", "0123456789"])); // 20 > 16
		await expect(call("https://example.com/big")).rejects.toMatchObject({ status: 413 });
	});

	it("keys a signed-in visitor's limit on their user id", async () => {
		await call("https://example.com/a.txt", {
			user: { _id: { toString: () => "user-42" } } as unknown as App.Locals["user"],
		});
		expect(fetchUrlAllowed).toHaveBeenCalledWith({ userId: "user-42", clientAddress: "203.0.113.7" });
	});
});
