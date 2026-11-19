import { describe, it, expect, vi, beforeEach } from "vitest";

// Whose sealed titles the route hands Search chats: the same owner scope as the search
// beside it. sealedTitleIndex is checked against Postgres in searchConversations.spec.ts.
const sealedTitleIndex = vi.fn(async (_owner: unknown) => [] as unknown[]);
vi.mock("$lib/chat/server/db/searchConversations", () => ({
	sealedTitleIndex: (owner: unknown) => sealedTitleIndex(owner),
}));

import { GET } from "./+server";

type Event = Parameters<typeof GET>[0];
const call = (locals: Partial<App.Locals>) => GET({ locals } as unknown as Event);

beforeEach(() => sealedTitleIndex.mockClear());

describe("GET /chat/api/conversations/search/sealed", () => {
	it("lists only the signed-in person's sealed titles, never their session's, and is never cached", async () => {
		sealedTitleIndex.mockResolvedValueOnce([{ id: "c1", sealedTitle: "blob", updatedAt: new Date(0) }]);
		const res = await call({ user: { _id: { toString: () => "user-1" } } as App.Locals["user"], sessionId: "sess-1" });
		expect(sealedTitleIndex).toHaveBeenCalledWith({ userId: "user-1" });
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect((await res.json()).conversations).toEqual([{ id: "c1", sealedTitle: "blob", updatedAt: new Date(0).toISOString() }]);
	});

	it("lists a guest's own session's sealed titles", async () => {
		await call({ sessionId: "sess-1" });
		expect(sealedTitleIndex).toHaveBeenCalledWith({ sessionId: "sess-1" });
	});

	it("refuses with 401 and reads nothing when there is neither a user nor a session", async () => {
		await expect(call({})).rejects.toMatchObject({ status: 401 });
		expect(sealedTitleIndex).not.toHaveBeenCalled();
	});
});
