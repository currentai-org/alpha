import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("$lib/chat/server/config", () => {
	const config = new Proxy({} as Record<string, string>, { get: () => "" });
	return { config, ready: Promise.resolve() };
});
import { resolveAgentRoute } from "./resolveAgentRoute";
import type { ProcessedModel } from "$lib/chat/server/models";

// The race behind "The agent wasn't reachable" under a normal answer on Auto, driven over a real
// socket with real clocks, scaled from seconds to milliseconds.
//
// The stand-in keeps agent-service's /route timing contract (agent-service/api/app.py `route_turn`):
// it counts the caller's `budget_ms` from the moment the request arrives, spends part of it on the
// input screen, and when the classify call is still running at the budget's end it answers "direct"
// with `source: "fallback"`. That answer comes after the chat started its own clock, because the
// request spent time in flight and in the screen, so a chat that waited exactly the budget gave up
// first and called a service that did answer unreachable.

const SCREEN_MS = 120;
const BUDGET_MS = 400;
const MARGIN_MS = 600;

type Mode = "slow-classify" | "hung";

let server: Server;
let baseURL: string;

function standIn(mode: Mode) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		const arrived = Date.now();
		let raw = "";
		for await (const chunk of req) raw += chunk;
		if (mode === "hung") return; // accepts the request and never answers
		const { budget_ms } = JSON.parse(raw) as { budget_ms?: number };
		await new Promise((r) => setTimeout(r, SCREEN_MS));
		// The classify call never returns in time; the service stops waiting at the budget's end.
		const left = Math.max(0, (budget_ms ?? 20_000) - (Date.now() - arrived));
		await new Promise((r) => setTimeout(r, left));
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ agentic: false, reason: "router error: ReadTimeout", source: "fallback", api: 1 }));
	};
}

let mode: Mode = "slow-classify";

beforeAll(async () => {
	server = createServer((req, res) => void standIn(mode)(req, res));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
	server.closeAllConnections();
	server.close();
});

function models(url: string) {
	const selected = { id: "apertus-70b" } as unknown as ProcessedModel;
	const agent = { id: "potluck-agent", endpoints: [{ type: "agent", baseURL: url }] } as unknown as ProcessedModel;
	return { selected, models: [selected, agent] };
}

describe("Auto's route check against a service whose classify runs out of time", () => {
	it("a service that falls back to direct at its budget's end leaves no agent-unreachable note", async () => {
		mode = "slow-classify";
		const { selected, models: ms } = models(baseURL);
		const started = Date.now();
		const d = await resolveAgentRoute({
			selected,
			models: ms,
			agentMode: "auto",
			prompt: "What is the capital of Portugal?",
			routeBudgetMs: BUDGET_MS,
			routeReplyMarginMs: MARGIN_MS,
		});
		expect(Date.now() - started, "the service's fallback should arrive after the budget").toBeGreaterThanOrEqual(
			BUDGET_MS
		);
		expect(d.route).toBe("selected");
		expect(d.failed, "the service answered, so the turn must not say it was unreachable").toBeUndefined();
		expect(d.reason).toBe("auto: router error: ReadTimeout");
	});

	it("the same service, waited on for exactly the budget, was reported unreachable: the race this fixes", async () => {
		mode = "slow-classify";
		const { selected, models: ms } = models(baseURL);
		const d = await resolveAgentRoute({
			selected,
			models: ms,
			agentMode: "auto",
			prompt: "What is the capital of Portugal?",
			routeBudgetMs: BUDGET_MS,
			routeReplyMarginMs: 0,
		});
		expect(d.failed).toBe(true);
		expect(d.reason).toBe("auto: route error (timeout)");
	});

	it("a service that never answers still gets the note, once budget and margin have both passed", async () => {
		mode = "hung";
		const { selected, models: ms } = models(baseURL);
		const started = Date.now();
		const d = await resolveAgentRoute({
			selected,
			models: ms,
			agentMode: "auto",
			prompt: "What is the capital of Portugal?",
			routeBudgetMs: BUDGET_MS,
			routeReplyMarginMs: MARGIN_MS,
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS + MARGIN_MS - 20);
		expect(d.failed).toBe(true);
		expect(d.reason).toBe("auto: route error (timeout)");
	});

	it("a service nobody can connect to gets the note", async () => {
		const closed = createServer();
		await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
		const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
		await new Promise<void>((r) => closed.close(() => r()));
		const { selected, models: ms } = models(url);
		const d = await resolveAgentRoute({
			selected,
			models: ms,
			agentMode: "auto",
			prompt: "What is the capital of Portugal?",
			routeBudgetMs: BUDGET_MS,
			routeReplyMarginMs: MARGIN_MS,
		});
		expect(d.failed).toBe(true);
		expect(d.reason).toBe("auto: route error (network)");
	});
});
