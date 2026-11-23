/**
 * The healthcheck has to answer "can this instance serve a chat turn", because that is what everything
 * reading it is asking: the Redeploy www workflow's smoke, post-deploy-smoke's rollback net, and anyone checking prod
 * during an incident.
 *
 * A literal "OK"/200 returned unconditionally would let a deployment serving "No models available" pass
 * every check.
 *
 * The mock here is `models`, NOT `ensureModelsReady`: stubbing the gate itself proves the route's
 * try/catch wiring and nothing about whether the endpoint asks the right question. The gate answers on
 * registry LENGTH, so five unlisted entries pass it while serving nobody. Mocking one level down lets the
 * unservable-registry case be a real assertion rather than a restatement of the mock.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";

const H = vi.hoisted(() => ({
	ready: vi.fn(),
	models: [] as Array<Record<string, unknown>>,
	operator: false,
	logError: vi.fn(),
}));

vi.mock("$lib/chat/server/cronAuth", () => ({ cronAuthorized: async () => H.operator }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { error: H.logError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("$lib/chat/server/storage/custodialCrypto", () => ({
	activeMasterKid: () => "kid-under-test",
	runCustodialCanary: async () => undefined,
}));

vi.mock("$lib/chat/server/models", () => ({
	ensureModelsReady: H.ready,
	get registryCanServe() {
		return () => H.models.some((m) => m.id !== AGENT_MODEL_ID && !m.unlisted);
	},
}));

const call = (GET: (e: { request: Request }) => Promise<Response>) =>
	GET({ request: new Request("https://chat.example.test/chat/healthcheck") });

const listed = (id: string) => ({ id, name: id, unlisted: false });
const unlisted = (id: string) => ({ id, name: id, unlisted: true });

beforeEach(() => {
	H.ready.mockReset().mockResolvedValue(undefined);
	H.models = [];
	H.operator = false;
	H.logError.mockReset();
});

describe("chat healthcheck", () => {
	it("is 200 when a visitor has a model to send a message to", async () => {
		H.models = [listed("swiss-ai/apertus-v1.5-70b")];
		const { GET } = await import("./+server");

		const res = await call(GET);

		expect(res.status).toBe(200);
		expect(H.ready).toHaveBeenCalledTimes(1);
	});

	// THE ONE THAT MATTERS, and the one the previous spec could not express. This is the exact
	// state: the registry is non-empty, so the request gate is satisfied, and there is still nothing a
	// visitor can pick. An endpoint that answers 200 here is the reason that deployment survived.
	it("is 503 when the registry holds only the agent and compare models", async () => {
		H.models = [{ id: AGENT_MODEL_ID, name: "agent" }, unlisted("compare/one"), unlisted("compare/two")];
		const { GET } = await import("./+server");

		const res = await call(GET);

		expect(res.status).toBe(503);
		expect((await res.json()).reason).toMatch(/send a message to/i);
	});

	// The endpoint is public. An upstream error can name internal hosts, so the caller gets only the
	// condition that failed, and the error itself reaches the server log.
	it("the public 503 response carries no internal error text, and the server log does", async () => {
		H.ready.mockRejectedValue(new Error("connect ECONNREFUSED gateway.internal.example.test:443"));
		const { GET } = await import("./+server");

		const res = await call(GET);
		const text = await res.text();

		expect(res.status).toBe(503);
		expect(JSON.parse(text)).toEqual({ ok: false, reason: expect.stringMatching(/registry is unavailable/i) });
		expect(text).not.toMatch(/ECONNREFUSED|gateway\.internal/);
		expect(H.logError).toHaveBeenCalledWith(
			{ err: expect.stringContaining("ECONNREFUSED gateway.internal.example.test") },
			expect.stringContaining("registry is unavailable")
		);
	});

	it("names the active custodial master kid only to an operator holding the cron secret", async () => {
		H.models = [listed("swiss-ai/apertus-v1.5-70b")];
		const { GET } = await import("./+server");

		const anonymous = await call(GET);
		H.operator = true;
		const operator = await call(GET);

		expect(anonymous.status).toBe(200);
		expect(anonymous.headers.get("x-custodial-master-kid")).toBeNull();
		expect(operator.headers.get("x-custodial-master-kid")).toBe("kid-under-test");
	});

	// A healthcheck that throws returns a framework 500, which reads as infrastructure rather than this
	// instance's own verdict. It has to answer, always.
	it("answers rather than throwing when the gate rejects with a non-Error", async () => {
		H.ready.mockRejectedValue("not even an Error");
		const { GET } = await import("./+server");

		await expect(call(GET)).resolves.toBeInstanceOf(Response);
	});
});
