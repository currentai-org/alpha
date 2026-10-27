/**
 * A compare-panel model reaches its host on its own key and is registered `unlisted`. The
 * conversation PATCH validates against this schema, so a visitor who names a compare model's id gets a
 * 400 rather than a conversation pinned to a model the picker never offered. (CUR-1875)
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/localEndpointsGate", () => ({ localInferenceEndpointsEnabled: () => false }));
vi.mock("$lib/chat/server/models", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/models")>()),
	models: [
		{ id: "listed/chat-model", name: "listed/chat-model", unlisted: false },
		{ id: "allenai/Olmo-3-32B", name: "allenai/Olmo-3-32B", unlisted: true },
	],
}));

const { getEffectiveValidModelIdSchema } = await import("./localModels");

describe("the per-request model schema refuses an unlisted compare model (CUR-1875)", () => {
	it("refuses the compare model's id and accepts the listed one", async () => {
		const schema = await getEffectiveValidModelIdSchema({} as App.Locals);
		expect(schema.safeParse("allenai/Olmo-3-32B").success).toBe(false);
		expect(schema.safeParse("listed/chat-model").success).toBe(true);
	});
});
