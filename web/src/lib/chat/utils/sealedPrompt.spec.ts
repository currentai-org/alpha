import { beforeEach, describe, expect, it, vi } from "vitest";

// XRAY's prompt view: a sealed chat posts what this tab opened, so the server rebuilds the
// prompt it cannot read; a plaintext chat is a GET as before; a refusal surfaces its reason.

const H = vi.hoisted(() => ({ sealed: {} as Record<string, unknown> }));
vi.mock("./sealedRequest", () => ({ sealedHistoryForRequest: async () => H.sealed }));

const { messagePrompt, PromptViewError } = await import("./sealedPrompt");

const CONV = "6543210fedcba98765432100";
const MSG = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
	H.sealed = {};
});

describe("messagePrompt", () => {
	it("posts the opened bodies of a sealed chat, so the server never has to read them from storage", async () => {
		const history = [{ id: MSG, rev: 0, body: { content: "opened words" } }];
		H.sealed = { history };
		const fetcher = vi.fn(async () => Response.json({ prompt: "user: opened words", model: "m" }));
		const out = await messagePrompt(CONV, MSG, "AGE-SECRET-KEY-1X", fetcher as unknown as typeof fetch);
		expect(out.prompt).toBe("user: opened words");
		const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(new RegExp(`/conversation/${CONV}/message/${MSG}/prompt$`));
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ history });
	});

	it("reads a chat with nothing sealed with a plain GET", async () => {
		const fetcher = vi.fn(async () => Response.json({ prompt: "user: plain", model: "m" }));
		await messagePrompt(CONV, MSG, null, fetcher as unknown as typeof fetch);
		expect(fetcher.mock.calls[0]).toHaveLength(1);
	});

	it("throws the server's reason for a refusal, rather than show an empty prompt", async () => {
		const fetcher = vi.fn(async () => Response.json({ message: "This chat is sealed with your history key." }, { status: 409 }));
		await expect(messagePrompt(CONV, MSG, null, fetcher as unknown as typeof fetch)).rejects.toThrow(PromptViewError);
		await expect(messagePrompt(CONV, MSG, null, fetcher as unknown as typeof fetch)).rejects.toThrow(/sealed with your history key/);
	});
});
