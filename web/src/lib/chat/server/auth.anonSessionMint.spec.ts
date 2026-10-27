import { describe, it, expect, vi, beforeEach } from "vitest";

// Every cookie-less mint gets its own anonymous session (CUR-1645). Coalescing two cookie-less
// requests from the same `(IP, User-Agent)` pair inside a short window into one session leaks one
// visitor's session to another: two clients sharing both are exactly what a NAT full of identical
// browser builds produces. A test that only checks clients sharing an IP but NOT a User-Agent stay
// separate leaves that case unasserted.
//
// The assertions here are the inverse of a coalescing contract, not additions to it: a suite that
// specifies the defect as correct has to be inverted, not extended (CUR-73). Every `it` below that
// says "never" goes red against a coalescing implementation.
//
// Mirrors auth.betterAuthBridge.spec.ts's DB-mocking convention.
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		sessions: {
			findOne: vi.fn(async () => null),
		},
		// Reached only by the valid-cookie test below, via findUser's own user lookup.
		users: {
			findOne: vi.fn(async () => null),
		},
		semaphores: {
			findOne: vi.fn(async () => null),
			insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "irrelevant" })),
			deleteOne: vi.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
			deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
		},
	},
}));

const getClientAddress = vi.fn(() => "203.0.113.5");
const userAgent = vi.fn((): string | null => "Mozilla/5.0 TestBrowser/1.0");
vi.mock("$app/server", () => ({
	getRequestEvent: () => ({
		getClientAddress: () => getClientAddress(),
		request: { headers: { get: (name: string) => (name === "user-agent" ? userAgent() : null) } },
	}),
}));

const getSession = vi.fn(async () => null as unknown);
vi.mock("$lib/chat/server/betterAuth", () => ({
	getAuth: () => ({ api: { getSession } }),
}));

import { authenticateRequest } from "./auth";
import { collections } from "$lib/chat/server/database";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const semaphoresFindOne = vi.mocked((collections as any).semaphores.findOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const semaphoresInsertOne = vi.mocked((collections as any).semaphores.insertOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const semaphoresDeleteMany = vi.mocked((collections as any).semaphores.deleteMany);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionsFindOne = vi.mocked((collections as any).sessions.findOne);

const url = new URL("http://localhost/chat/");
const noCookies = { get: () => undefined } as unknown as Parameters<typeof authenticateRequest>[1];
// The retired correlation key, kept as a fixture so the "never adopts" tests can plant a row under
// the exact key the old read path would have matched. If a future change reintroduces coalescing on
// this key, those tests are what goes red.
const RETIRED_KEY = "anon.session.mint:203.0.113.5:Mozilla/5.0 TestBrowser/1.0";
const recentDoc = (overrides: Record<string, unknown>) => ({ createdAt: new Date(), ...overrides });

describe("mintAnonymousSession — every cookie-less mint gets its own session (CUR-1645)", () => {
	beforeEach(() => {
		getClientAddress.mockReset().mockReturnValue("203.0.113.5");
		userAgent.mockReset().mockReturnValue("Mozilla/5.0 TestBrowser/1.0");
		semaphoresFindOne.mockReset().mockResolvedValue(null);
		semaphoresInsertOne.mockReset().mockResolvedValue({ acknowledged: true, insertedId: "x" });
		semaphoresDeleteMany.mockReset().mockResolvedValue({ acknowledged: true, deletedCount: 1 });
		sessionsFindOne.mockReset().mockResolvedValue(null);
	});

	// Two cookie-less visitors indistinguishable by IP and User-Agent
	// — a conference NAT, a classroom, a corporate standard image, or our own scenario suite's two
	// headless workers — must not end up in one session: handing both the SAME
	// secretSessionId would let a stranger read and wipe a stranger's conversation.
	it("never hands two cookie-less requests with an identical IP and User-Agent the same session", async () => {
		// The mock PERSISTS here, and that is the whole test. With `insertOne` writing nowhere and
		// `findOne` answering null, a source that adopts an existing row would also mint twice — its read
		// path simply finds nothing — so this test would pass against the bug and prove nothing, which is the
		// "expected answer is also the default answer" failure. Backing the two onto one map makes
		// request 2 see request 1's row, which the source must not adopt.
		const store = new Map<string, Record<string, unknown>>();
		semaphoresInsertOne.mockImplementation(async (doc: Record<string, unknown>) => {
			store.set(String(doc.key), doc);
			return { acknowledged: true, insertedId: "x" };
		});
		semaphoresFindOne.mockImplementation(
			async (filter: { key?: string }) => store.get(String(filter?.key)) ?? null
		);

		const first = await authenticateRequest(new Headers(), noCookies, url);
		const second = await authenticateRequest(new Headers(), noCookies, url);

		expect(first.secretSessionId).toBeTruthy();
		expect(second.secretSessionId).toBeTruthy();
		expect(second.secretSessionId).not.toBe(first.secretSessionId);
		expect(second.sessionId).not.toBe(first.sessionId);
	});

	// The read half of the removal. A row sitting under the retired key, recent enough that the old
	// code would have adopted it, must be ignored — otherwise a stale deployment's leftover rows keep
	// handing out sessions after the fingerprint is supposed to be gone.
	it("never adopts a recorded session, even a recent one under the retired correlation key", async () => {
		semaphoresFindOne.mockResolvedValue(
			recentDoc({
				key: RETIRED_KEY,
				sessionId: "previously-adopted-session-hash",
				secretSessionId: "previously-adopted-secret-token",
			})
		);

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.secretSessionId).not.toBe("previously-adopted-secret-token");
		expect(result.sessionId).not.toBe("previously-adopted-session-hash");
	});

	// The write half. Nothing should record a new correlation row — those rows held the raw
	// `secretSessionId` in the clear (CUR-1325), and the whole reason the sweep below can ever finish
	// draining them is that the writer is gone.
	it("never records a correlation row, so no new plaintext secretSessionId is written", async () => {
		await authenticateRequest(new Headers(), noCookies, url);

		expect(semaphoresInsertOne).not.toHaveBeenCalled();
	});

	// The flag hooks/handle.ts reads to decide whether to Set-Cookie on a non-POST. Without it the
	// browser is never told which session rendered its page, every subsequent request arrives
	// cookie-less and mints again, and the burst that made coalescing necessary comes straight back.
	it("reports mintedSession on the cookie-less path, so the hook hands the cookie back on any method", async () => {
		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.mintedSession).toBe(true);
	});

	// The inverse, and it is not symmetry for its own sake: if this were true for a request that
	// presented a valid cookie, every GET would rewrite the cookie and re-extend its expiry as a side
	// effect of being read, which is a different bug wearing this fix's clothes.
	it("does not report mintedSession when the request already carries a valid session cookie", async () => {
		const token = "11111111-2222-3333-4444-555555555555";
		const withCookie = {
			get: (name: string) => (name === "hf-chat" ? token : undefined),
		} as unknown as Parameters<typeof authenticateRequest>[1];
		sessionsFindOne.mockResolvedValue({ sessionId: "irrelevant", userId: undefined });

		const result = await authenticateRequest(new Headers(), withCookie, url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(token);
	});

	// Retention (CUR-1325). The retired rows hold a live bearer value in readable form, so a mint drains
	// them — scoped on `secretSessionId` existing, which is what keeps it off the lock rows sharing this
	// collection, and NOT scoped to one key, since that narrowing is what left other clients' rows
	// behind in the first place.
	//
	// The absence of a `deleteAt` predicate is asserted, not incidental. Nothing reads these rows, so an
	// unexpired one is a plaintext credential with no purpose, and a predicate sparing it would leave the
	// drain permanently incomplete for any client that keeps arriving.
	it("sweeps every retired correlation row on a mint — no expiry predicate, never the lock rows", async () => {
		await authenticateRequest(new Headers(), noCookies, url);

		expect(semaphoresDeleteMany).toHaveBeenCalledTimes(1);
		const filter = semaphoresDeleteMany.mock.calls[0][0];
		expect(filter.secretSessionId).toEqual({ $exists: true });
		expect(filter).not.toHaveProperty("deleteAt");
		expect(filter).not.toHaveProperty("key");
	});

	// The sweep is best-effort and runs on the request path. A semaphores hiccup turning every first
	// visit into a 500 would be far worse than the retention it fixes.
	//
	// The `toHaveBeenCalled` line is not decoration. Without it this test passes for the wrong reason
	// against any source that never calls deleteMany at all — the rejection never fires, minting
	// proceeds, and the assertions hold while proving nothing. Asserting the sweep was attempted is
	// what makes the survival claim mean something.
	it("still mints when the sweep itself fails, rather than failing the request", async () => {
		semaphoresDeleteMany.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(semaphoresDeleteMany).toHaveBeenCalledTimes(1);
		expect(result.secretSessionId).toBeTruthy();
		expect(result.mintedSession).toBe(true);
	});

	// The one guard that predates all of this and must not be lost in the subtraction: a minted id
	// that somehow already names a live session is refused rather than handed out.
	it("refuses to hand out a freshly minted id that already names a live session", async () => {
		sessionsFindOne.mockResolvedValue({ sessionId: "collision" });

		await expect(authenticateRequest(new Headers(), noCookies, url)).rejects.toThrow(
			/Session ID collision/
		);
	});
});
