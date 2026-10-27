import { describe, it, expect, vi, afterEach } from "vitest";

// The agent endpoint names its token's env var; resolveAgentRoute reads the value at call time (CUR-2640).
vi.mock("$lib/chat/server/config", () => {
	const cfg: Record<string, string> = { AGENT_SERVICE_TOKEN: "tok-123" };
	const config = new Proxy(cfg, { get: (t, prop) => (prop in t ? Reflect.get(t, prop) : "") });
	return { config, ready: Promise.resolve() };
});
import { logger } from "$lib/chat/server/logger";
import { resolveAgentRoute, takeAgentRouteFailureCount } from "./resolveAgentRoute";
import type { ProcessedModel } from "$lib/chat/server/models";

// Minimal stand-ins — resolveAgentRoute only reads .id and (on the agent) .endpoints[0].baseURL/apiKeyEnv.
const selected = { id: "apertus-70b" } as unknown as ProcessedModel;
const agent = {
	id: "potluck-agent",
	endpoints: [{ type: "agent", baseURL: "http://agent.test/", apiKeyEnv: "AGENT_SERVICE_TOKEN" }],
} as unknown as ProcessedModel;
const models = [selected, agent];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as unknown as Response;
}

describe("resolveAgentRoute", () => {
	it("off / undefined → the selected model, no /route call", async () => {
		const fetchImpl = vi.fn();
		for (const agentMode of [undefined, "off" as const]) {
			const d = await resolveAgentRoute({ selected, models, agentMode, prompt: "hi", fetchImpl });
			expect(d.route).toBe("selected");
			expect(d.model).toBe(selected);
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("on → forces the agent model (no /route call)", async () => {
		const fetchImpl = vi.fn();
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "on",
			prompt: "hi",
			fetchImpl,
		});
		expect(d.route).toBe("agent");
		expect(d.model).toBe(agent);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("auto keeps a turn carrying a document on the selected model, never asking /route (the agent cannot read it)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ route: "agent" }));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "summarise the attached policy",
			carriesDocument: true,
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.model).toBe(selected);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("on still forces the agent when the turn carries a document (the user chose it)", async () => {
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "on",
			prompt: "hi",
			carriesDocument: true,
			fetchImpl: vi.fn(),
		});
		expect(d.route).toBe("agent");
	});

	it("on but agent not configured → fail-open to selected", async () => {
		const d = await resolveAgentRoute({
			selected,
			models: [selected],
			agentMode: "on",
			prompt: "hi",
			fetchImpl: vi.fn(),
		});
		expect(d.route).toBe("selected");
		expect(d.reason).toMatch(/not configured/);
	});

	it("agentAllowed:false denies force-on → selected, never touches /route (fail-closed per-user gate)", async () => {
		const fetchImpl = vi.fn();
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "on",
			prompt: "hi",
			agentAllowed: false,
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.model).toBe(selected);
		expect(d.reason).toMatch(/not allowed/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("agentAllowed:false denies auto → selected, no classifier call even with a prompt", async () => {
		const fetchImpl = vi.fn();
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "write me a script",
			agentAllowed: false,
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("agentAllowed:true is the same as omitting it — a cleared tester still routes on", async () => {
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "on",
			prompt: "hi",
			agentAllowed: true,
			fetchImpl: vi.fn(),
		});
		expect(d.route).toBe("agent");
		expect(d.model).toBe(agent);
	});

	it("auto + classifier says agentic → routes to the agent, calls /route with bearer", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ agentic: true, reason: "needs code" }));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "build X",
			fetchImpl,
		});
		expect(d.route).toBe("agent");
		expect(d.model).toBe(agent);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("http://agent.test/route"); // trailing slash on baseURL normalized
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
		expect(JSON.parse(init.body)).toEqual({ prompt: "build X" });
	});

	it("auto + classifier says direct → stays on the selected model", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ agentic: false, reason: "just a question" }));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "what is 2+2?",
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.model).toBe(selected);
	});

	it("auto + an attached image → the selected model, never the agent, which can't read images (CUR-454)", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ agentic: true, reason: "requires image analysis" }));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "What colour is the circle in this picture?",
			hasImage: true,
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.model).toBe(selected);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("auto + web search Always → the selected model, never the agent, which can't search, even when /route says agentic", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ agentic: true, reason: "requires live web research" }));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "What do the current rules say about this?",
			webSearchAlways: true,
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.model).toBe(selected);
		expect(d.reason).toMatch(/web search is Always/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("forced on + web search Always → still the agent: forcing it is the person's choice", async () => {
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "on",
			prompt: "x",
			webSearchAlways: true,
		});
		expect(d.route).toBe("agent");
	});

	it("auto + /route non-OK → fail-open to selected, counts as http_error", async () => {
		takeAgentRouteFailureCount(); // drain any count left by an earlier test in this file
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "x",
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.reason).toMatch(/503/);
		expect(takeAgentRouteFailureCount()).toBe(1);
	});

	it("auto + /route throws → fail-open to selected, counts as a failure", async () => {
		takeAgentRouteFailureCount();
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network reset"));
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "x",
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(d.reason).toMatch(/error/);
		expect(takeAgentRouteFailureCount()).toBe(1);
	});

	it("auto + no prompt (retry/continue) → selected, no /route call", async () => {
		const fetchImpl = vi.fn();
		const d = await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "   ",
			fetchImpl,
		});
		expect(d.route).toBe("selected");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	describe("CUR-1260: failure reason is classified into a closed set, and counted", () => {
		it("takeAgentRouteFailureCount reads and resets in one call", async () => {
			takeAgentRouteFailureCount();
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
			await resolveAgentRoute({ selected, models, agentMode: "auto", prompt: "x", fetchImpl });
			expect(takeAgentRouteFailureCount()).toBe(1);
			expect(takeAgentRouteFailureCount()).toBe(0); // already reset by the read above
		});

		it("a TimeoutError (AbortSignal.timeout's own failure name) classifies as timeout", async () => {
			takeAgentRouteFailureCount();
			const err = new Error("The operation was aborted due to timeout");
			err.name = "TimeoutError";
			const fetchImpl = vi.fn().mockRejectedValue(err);
			const d = await resolveAgentRoute({
				selected,
				models,
				agentMode: "auto",
				prompt: "x",
				fetchImpl,
			});
			expect(d.reason).toBe("auto: route error (timeout)");
			expect(takeAgentRouteFailureCount()).toBe(1);
		});

		it("a TypeError (Node/undici's DNS/connection-refused wrapper) classifies as network", async () => {
			takeAgentRouteFailureCount();
			const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
			const d = await resolveAgentRoute({
				selected,
				models,
				agentMode: "auto",
				prompt: "x",
				fetchImpl,
			});
			expect(d.reason).toBe("auto: route error (network)");
			expect(takeAgentRouteFailureCount()).toBe(1);
		});

		it("a non-JSON 2xx body (res.json() throws SyntaxError) classifies as parse_error", async () => {
			takeAgentRouteFailureCount();
			const fetchImpl = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError("Unexpected token < in JSON");
				},
			} as unknown as Response);
			const d = await resolveAgentRoute({
				selected,
				models,
				agentMode: "auto",
				prompt: "x",
				fetchImpl,
			});
			expect(d.reason).toBe("auto: route error (parse_error)");
			expect(takeAgentRouteFailureCount()).toBe(1);
		});

		it("an error with no recognized name classifies as unknown", async () => {
			takeAgentRouteFailureCount();
			const fetchImpl = vi.fn().mockRejectedValue(new RangeError("out of range"));
			const d = await resolveAgentRoute({
				selected,
				models,
				agentMode: "auto",
				prompt: "x",
				fetchImpl,
			});
			expect(d.reason).toBe("auto: route error (unknown)");
			expect(takeAgentRouteFailureCount()).toBe(1);
		});

		it("a healthy /route call never increments the counter", async () => {
			takeAgentRouteFailureCount();
			const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ agentic: false }));
			await resolveAgentRoute({ selected, models, agentMode: "auto", prompt: "x", fetchImpl });
			expect(takeAgentRouteFailureCount()).toBe(0);
		});
	});
});

// A forced "on" that falls back to plain chat logs its route and reason too. Every on/auto
// turn logs its route and reason, whichever way it went. (CUR-905)
describe("CUR-2830: only an auto route check that got no verdict is marked failed", () => {
	const auto = (fetchImpl: typeof fetch) =>
		resolveAgentRoute({ selected, models, agentMode: "auto", prompt: "x", fetchImpl });

	it("marks failed on a non-OK reply, a thrown fetch and an unreadable body", async () => {
		const unreadable = { ok: true, status: 200, json: async () => JSON.parse("<html>") } as unknown as Response;
		for (const fetchImpl of [
			vi.fn(async () => jsonResponse({}, false, 503)),
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
			vi.fn(async () => unreadable),
		]) {
			const d = await auto(fetchImpl as unknown as typeof fetch);
			expect(d.route).toBe("selected");
			expect(d.failed).toBe(true);
		}
	});

	it("leaves failed unset when the agent's input screen refuses the prompt, since the service answered (CUR-4056)", async () => {
		const refused = {
			ok: false,
			status: 403,
			text: async () => '{"detail":"blocked by moderation (input): illegal_activity"}',
		} as unknown as Response;
		const d = await auto(vi.fn(async () => refused) as unknown as typeof fetch);
		expect(d.route).toBe("selected");
		expect(d.failed).toBeUndefined();
	});

	it("still marks failed on a 403 that is not the input screen, such as a bad token", async () => {
		const denied = { ok: false, status: 403, text: async () => '{"detail":"forbidden"}' } as unknown as Response;
		const d = await auto(vi.fn(async () => denied) as unknown as typeof fetch);
		expect(d.failed).toBe(true);
	});

	it("leaves failed unset when the classifier answers direct, or agentic", async () => {
		for (const agentic of [false, true]) {
			const d = await auto(vi.fn(async () => jsonResponse({ agentic })) as unknown as typeof fetch);
			expect(d.failed).toBeUndefined();
		}
	});

	it("leaves failed unset for every decision that never asks /route", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const decisions = await Promise.all([
			resolveAgentRoute({ selected, models, agentMode: "off", prompt: "x", fetchImpl }),
			resolveAgentRoute({ selected, models, agentMode: "on", prompt: "x", fetchImpl }),
			resolveAgentRoute({ selected, models: [selected], agentMode: "auto", prompt: "x", fetchImpl }),
			resolveAgentRoute({ selected, models, agentMode: "auto", prompt: "", fetchImpl }),
		]);
		for (const d of decisions) expect(d.failed).toBeUndefined();
	});
});

describe("CUR-905: every on/auto decision is logged with its reason", () => {
	afterEach(() => vi.restoreAllMocks());

	const fallbacks = [
		{ name: "not allowed for this user", models, agentAllowed: false, reason: /not allowed/ },
		{ name: "agent model not configured", models: [selected], agentAllowed: undefined, reason: /not configured/ },
	];

	for (const f of fallbacks) {
		it(`a forced "on" that falls back (${f.name}) logs a warn naming the reason`, async () => {
			const warn = vi.spyOn(logger, "warn");
			await resolveAgentRoute({
				selected,
				models: f.models,
				agentMode: "on",
				prompt: "hi",
				agentAllowed: f.agentAllowed,
				fetchImpl: vi.fn(),
			});
			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({ agentMode: "on", route: "selected", reason: expect.stringMatching(f.reason) }),
				"[agent-route] forced on, answered by the selected model"
			);
		});
	}

	it("an auto turn the classifier keeps direct logs at info with the classifier's reason", async () => {
		const info = vi.spyOn(logger, "info");
		await resolveAgentRoute({
			selected,
			models,
			agentMode: "auto",
			prompt: "what is 2+2",
			fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ agentic: false, reason: "simple question" })),
		});
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ agentMode: "auto", route: "selected", reason: "auto: simple question" }),
			"[agent-route] resolved"
		);
	});

	it("a forced \"on\" that reaches the agent logs at info, not warn", async () => {
		const info = vi.spyOn(logger, "info");
		const warn = vi.spyOn(logger, "warn");
		await resolveAgentRoute({ selected, models, agentMode: "on", prompt: "hi", fetchImpl: vi.fn() });
		expect(info).toHaveBeenCalledWith(expect.objectContaining({ route: "agent" }), "[agent-route] resolved");
		expect(warn).not.toHaveBeenCalled();
	});

	it("an off turn logs nothing", async () => {
		const info = vi.spyOn(logger, "info");
		const warn = vi.spyOn(logger, "warn");
		await resolveAgentRoute({ selected, models, agentMode: "off", prompt: "hi", fetchImpl: vi.fn() });
		expect(info).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});
