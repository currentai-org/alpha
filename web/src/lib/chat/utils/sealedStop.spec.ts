import { describe, expect, it, vi } from "vitest";
import { finishSealedStop } from "./sealedStop";

// The browser's half of the sealed stop clamp: asked for the stopped answer's body, it
// sends the body it opened from the stored blob, at the revision the server named, and nothing else.

const stopPoint = { generationId: "0b4cf0e7-6f7a-4c43-9f53-6a3c9a1f2f10", seenContentLength: 12 };
const asked = () =>
	new Response(JSON.stringify({ sealedClamp: { messageId: "a1", rev: 3 } }), {
		headers: { "content-type": "application/json" },
	});
const body = { content: "opened words" };

describe("finishSealedStop", () => {
	it("sends nothing more after a stop the server finished on its own", async () => {
		const post = vi.fn();
		const reopen = vi.fn();
		expect(await finishSealedStop({ first: new Response(null), stopPoint, reopen, post })).toBe("not_sealed");
		expect(reopen).not.toHaveBeenCalled();
		expect(post).not.toHaveBeenCalled();
	});

	it("posts the stop point with the opened body of the answer at the revision the server named", async () => {
		const post = vi.fn(async () => new Response(null));
		const reopen = async () => ({
			history: [
				{ id: "u1", rev: 0, body: { content: "question" } },
				{ id: "a1", rev: 3, body },
			],
		});
		expect(await finishSealedStop({ first: asked(), stopPoint, reopen, post })).toBe("sent");
		expect(post).toHaveBeenCalledWith({ ...stopPoint, opened: { id: "a1", rev: 3, body } });
	});

	it("sends nothing from a tab that cannot open the answer, or opened another revision of it", async () => {
		const post = vi.fn();
		expect(await finishSealedStop({ first: asked(), stopPoint, reopen: async () => ({}), post })).toBe("locked");
		expect(
			await finishSealedStop({
				first: asked(),
				stopPoint,
				reopen: async () => ({ history: [{ id: "a1", rev: 2, body }] }),
				post,
			})
		).toBe("locked");
		expect(post).not.toHaveBeenCalled();
	});

	it("reports a refused body rather than claiming the answer was cut", async () => {
		const post = vi.fn(async () => new Response("no", { status: 409 }));
		const reopen = async () => ({ history: [{ id: "a1", rev: 3, body }] });
		expect(await finishSealedStop({ first: asked(), stopPoint, reopen, post })).toBe("refused");
	});
});
