/**
 * The healthcheck has to answer "can this instance serve a chat turn", because that is what everything
 * reading it is asking: deploy-prod.sh's gate, post-deploy-smoke's rollback net, and anyone checking prod
 * during an incident.
 *
 * A literal "OK"/200 returned unconditionally would let a deployment serving "No models available" pass
 * every check (CUR-1246).
 *
 * The mock here is `models`, NOT `ensureModelsReady`: stubbing the gate itself proves the route's
 * try/catch wiring and nothing about whether the endpoint asks the right question. The gate answers on
 * registry LENGTH, so five unlisted entries pass it while serving nobody. Mocking one level down lets the
 * unservable-registry case be a real assertion rather than a restatement of the mock.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";

const H = vi.hoisted(() => ({ ready: vi.fn(), models: [] as Array<Record<string, unknown>> }));

vi.mock("$lib/chat/server/models", () => ({
	ensureModelsReady: H.ready,
	get registryCanServe() {
		return () => H.models.some((m) => m.id !== AGENT_MODEL_ID && !m.unlisted);
	},
}));

const listed = (id: string) => ({ id, name: id, unlisted: false });
const unlisted = (id: string) => ({ id, name: id, unlisted: true });

beforeEach(() => {
	H.ready.mockReset().mockResolvedValue(undefined);
	H.models = [];
});

describe("chat healthcheck", () => {
	it("is 200 when a visitor has a model to send a message to", async () => {
		H.models = [listed("swiss-ai/apertus-v1.5-70b")];
		const { GET } = await import("./+server");

		const res = await GET();

		expect(res.status).toBe(200);
		expect(H.ready).toHaveBeenCalledTimes(1);
	});

	// THE ONE THAT MATTERS, and the one the previous spec could not express. This is the exact CUR-1246
	// state: the registry is non-empty, so the request gate is satisfied, and there is still nothing a
	// visitor can pick. An endpoint that answers 200 here is the reason that deployment survived.
	it("is 503 when the registry holds only the agent and compare models", async () => {
		H.models = [{ id: AGENT_MODEL_ID, name: "agent" }, unlisted("compare/one"), unlisted("compare/two")];
		const { GET } = await import("./+server");

		const res = await GET();

		expect(res.status).toBe(503);
		expect((await res.json()).reason).toMatch(/send a message to/i);
	});

	it("is 503 when the registry gate itself fails", async () => {
		H.ready.mockRejectedValue(new Error("Failed to load any models from upstream"));
		const { GET } = await import("./+server");

		const res = await GET();

		expect(res.status).toBe(503);
		expect((await res.json()).detail).toMatch(/models/i);
	});

	// A healthcheck that throws returns a framework 500, which reads as infrastructure rather than this
	// instance's own verdict. It has to answer, always.
	it("answers rather than throwing when the gate rejects with a non-Error", async () => {
		H.ready.mockRejectedValue("not even an Error");
		const { GET } = await import("./+server");

		await expect(GET()).resolves.toBeInstanceOf(Response);
	});
});
