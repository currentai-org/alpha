/**
 * The conversation PATCH (rename, switch model) answers a bad title or model id with 400 and
 * writes nothing. It used `.parse`, whose ZodError SvelteKit answered 500. (CUR-3699)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import { z } from "zod";

const h = vi.hoisted(() => ({
	findOne: vi.fn(),
	updateOne: vi.fn(async () => ({ acknowledged: true })),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { conversations: { findOne: h.findOne, updateOne: h.updateOne } },
}));

// The selectable ids for this caller: one catalog model and one of their own local models.
vi.mock("$lib/chat/server/localModels", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/localModels")>()),
	getEffectiveValidModelIdSchema: async () => {
		const ids = new Set(["test-model", "local:test-local"]);
		return z.string().refine((v) => ids.has(v), "Invalid model id");
	},
	prewarmLocalModelForUser: async () => {},
}));

const { PATCH } = await import("./+server");

const userId = new ObjectId();
const convId = new ObjectId();

function patch(body: unknown) {
	return PATCH({
		request: new Request(`http://localhost/chat/conversation/${convId}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
		locals: { user: { _id: userId }, sessionId: "s" },
		params: { id: convId.toString() },
	} as unknown as Parameters<typeof PATCH>[0]);
}

async function status(body: unknown): Promise<number> {
	try {
		return (await patch(body)).status;
	} catch (e) {
		return (e as { status?: number }).status ?? 500;
	}
}

beforeEach(() => {
	h.findOne.mockReset();
	h.findOne.mockResolvedValue({ _id: convId, userId });
	h.updateOne.mockClear();
});

describe("conversation PATCH answers bad input with 400 and writes nothing (CUR-3699)", () => {
	it("refuses a model id the caller cannot pick with 400", async () => {
		expect(await status({ model: "not-a-model" })).toBe(400);
		expect(h.updateOne).not.toHaveBeenCalled();
	});

	it("refuses a 101-character title with 400", async () => {
		expect(await status({ title: "x".repeat(101) })).toBe(400);
		expect(h.updateOne).not.toHaveBeenCalled();
	});

	it("refuses a body that is not JSON with 400", async () => {
		const res = await PATCH({
			request: new Request(`http://localhost/chat/conversation/${convId}`, { method: "PATCH", body: "{" }),
			locals: { user: { _id: userId }, sessionId: "s" },
			params: { id: convId.toString() },
		} as unknown as Parameters<typeof PATCH>[0]).catch((e: { status?: number }) => e);
		expect((res as { status?: number }).status).toBe(400);
		expect(h.updateOne).not.toHaveBeenCalled();
	});

	it("still switches to a listed model and to the caller's own local model", async () => {
		expect(await status({ model: "test-model" })).toBe(200);
		expect(await status({ model: "local:test-local" })).toBe(200);
		expect(h.updateOne).toHaveBeenCalledTimes(2);
		expect(h.updateOne.mock.calls[1]).toEqual([{ _id: convId }, { $set: { model: "local:test-local" } }]);
	});

	it("still renames with a 100-character title", async () => {
		expect(await status({ title: "x".repeat(100) })).toBe(200);
		expect(h.updateOne).toHaveBeenCalledWith({ _id: convId }, { $set: { title: "x".repeat(100) } });
	});
});
