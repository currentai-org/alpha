import { beforeEach, describe, expect, it, vi } from "vitest";

const multimodalOnSignIn = vi.fn();
vi.mock("$lib/chat/server/textOnly", () => ({ multimodalOnSignIn }));

const { GET } = await import("./+server");

const call = (locals: Partial<App.Locals>) =>
	GET({ locals } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;

describe("GET /chat/api/sign-in-hint (CUR-3015)", () => {
	beforeEach(() => multimodalOnSignIn.mockReset());

	it("answers a guest from the flag evaluated for that guest's own session", async () => {
		multimodalOnSignIn.mockResolvedValue(true);
		const res = await call({ sessionId: "session-a" });
		expect(await res.json()).toEqual({ photos: true });
		expect(multimodalOnSignIn).toHaveBeenCalledWith("session-a");
	});

	it("says no to a signed-in visitor without asking PostHog, since their own answer is already on the page", async () => {
		const res = await call({ sessionId: "session-b", user: { _id: "u" } as unknown as App.Locals["user"] });
		expect(await res.json()).toEqual({ photos: false });
		expect(multimodalOnSignIn).not.toHaveBeenCalled();
	});
});
