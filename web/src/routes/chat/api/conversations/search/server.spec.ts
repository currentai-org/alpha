import { describe, it, expect, vi, beforeEach } from "vitest";

// The route decides whose chats are searched. searchConversations.spec.ts checks the query
// against Postgres; this checks the scope the route hands it, which nothing else did (SOL-195). (CUR-2630)
const searchConversations = vi.fn(async (_owner: unknown, _q: string) => [] as unknown[]);
vi.mock("$lib/chat/server/db/searchConversations", () => ({
	searchConversations: (owner: unknown, q: string) => searchConversations(owner, q),
}));

import { POST } from "./+server";

type Event = Parameters<typeof POST>[0];
const call = (q: string | null, locals: Partial<App.Locals>) =>
	POST({
		request: new Request("http://localhost/chat/api/conversations/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(q === null ? {} : { q }),
		}),
		locals,
	} as unknown as Event);

beforeEach(() => searchConversations.mockClear());

describe("POST /chat/api/conversations/search", () => {
	it("searches only the signed-in person's chats, never their session's, and is never cached", async () => {
		searchConversations.mockResolvedValueOnce([{ id: "c1", title: "Trip", updatedAt: new Date(0) }]);
		const res = await call("quillowend", {
			user: { _id: { toString: () => "user-1" } } as App.Locals["user"],
			sessionId: "sess-1",
		});
		expect(searchConversations).toHaveBeenCalledWith({ userId: "user-1" }, "quillowend");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect((await res.json()).conversations).toHaveLength(1);
	});

	it("searches a guest's own session's chats", async () => {
		await call("quillowend", { sessionId: "sess-1" });
		expect(searchConversations).toHaveBeenCalledWith({ sessionId: "sess-1" }, "quillowend");
	});

	it("refuses with 401 and searches nothing when there is neither a user nor a session", async () => {
		await expect(call("quillowend", {})).rejects.toMatchObject({ status: 401 });
		expect(searchConversations).not.toHaveBeenCalled();
	});

	it("passes an empty query through when q is missing, which the query answers with nothing", async () => {
		await call(null, { sessionId: "sess-1" });
		expect(searchConversations).toHaveBeenCalledWith({ sessionId: "sess-1" }, "");
	});
});
