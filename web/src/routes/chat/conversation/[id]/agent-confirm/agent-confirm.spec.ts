/**
 * CUR-779 DoD line 2: the client has to tell a flag-disabled confirm apart from an ownership
 * mismatch, a dead task, and a plain send failure — which means this route has to tag each of
 * those with a distinct `reason` rather than just a `message` (message text is for a human reading
 * a stack trace, not for a client to switch on). This locks in that every branch actually carries
 * the reason AgentConfirmPrompt.svelte's SEND_ERROR_COPY map depends on.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import { POST } from "./+server";

const agentConfirmUiEnabled = vi.fn(() => true);
vi.mock("$lib/chat/server/agentConfirmUi", () => ({
	agentConfirmUiEnabled: () => agentConfirmUiEnabled(),
}));

const agentServiceUrl = vi.fn(() => "http://agent.test");
vi.mock("$lib/chat/server/agentMode", () => ({
	agentServiceUrl: () => agentServiceUrl(),
	agentServiceToken: () => "tok",
}));

vi.mock("$lib/chat/server/endpoints/agent/endpointAgent", () => ({
	agentServiceHeaders: () => ({ "x-agent-subject": "subject" }),
}));

vi.mock("$lib/chat/server/loadOwnedConversation", () => ({
	loadOwnedConversation: vi.fn(async () => new ObjectId()),
}));

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

async function postConfirm(upstreamStatus: number): Promise<Response> {
	const fetchMock = vi.fn(async () => ({ ok: upstreamStatus < 400, status: upstreamStatus }) as Response);
	vi.stubGlobal("fetch", fetchMock);
	const request = new Request("http://localhost/conversation/c1/agent-confirm", {
		method: "POST",
		body: JSON.stringify({ taskId: "t1", confirmId: "cf1", decision: "allow" }),
	});
	return await POST({ request, locals: {} as App.Locals, params: { id: "c1" } } as never);
}

async function reasonOf(p: Promise<Response>): Promise<{ status: number; reason?: string }> {
	try {
		await p;
		expect.fail("expected a thrown SvelteKit error");
	} catch (e: unknown) {
		const err = e as { status: number; body: { reason?: string } };
		return { status: err.status, reason: err.body.reason };
	}
}

describe.sequential("POST /conversation/[id]/agent-confirm — reason tagging", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		agentConfirmUiEnabled.mockReturnValue(true);
		agentServiceUrl.mockReturnValue("http://agent.test");
	});

	it("flag off → 403, reason=flag_disabled, before any upstream call", async () => {
		agentConfirmUiEnabled.mockReturnValue(false);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { status, reason } = await reasonOf(postConfirm(200));
		expect(status).toBe(403);
		expect(reason).toBe("flag_disabled");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("AGENT_SERVICE_URL unset → 404, reason=service_unreachable", async () => {
		agentServiceUrl.mockReturnValue("");
		const { status, reason } = await reasonOf(postConfirm(200));
		expect(status).toBe(404);
		expect(reason).toBe("service_unreachable");
	});

	it("upstream 404 → reason=not_found", async () => {
		const { status, reason } = await reasonOf(postConfirm(404));
		expect(status).toBe(404);
		expect(reason).toBe("not_found");
	});

	it("upstream 403 → reason=not_yours (ownership mismatch)", async () => {
		const { status, reason } = await reasonOf(postConfirm(403));
		expect(status).toBe(403);
		expect(reason).toBe("not_yours");
	});

	it("upstream 409 → NOT thrown, passthrough ok:false reason=already_resolved (stale click)", async () => {
		const res = await postConfirm(409);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ ok: false, reason: "already_resolved" });
	});

	it("upstream 5xx → 502, reason=upstream_error", async () => {
		const { status, reason } = await reasonOf(postConfirm(500));
		expect(status).toBe(502);
		expect(reason).toBe("upstream_error");
	});

	// AGENT_SERVICE_URL is set but the service is unreachable (DNS, ECONNREFUSED, TLS) — a
	// different case from "unset" above. `fetch` throws instead of returning a Response, and the route
	// answers `service_unreachable` rather than propagating a raw 500 with no `reason`.
	it("network failure reaching a CONFIGURED service → 502, reason=service_unreachable", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		vi.stubGlobal("fetch", fetchMock);
		const request = new Request("http://localhost/conversation/c1/agent-confirm", {
			method: "POST",
			body: JSON.stringify({ taskId: "t1", confirmId: "cf1", decision: "allow" }),
		});
		const { status, reason } = await reasonOf(
			Promise.resolve(POST({ request, locals: {} as App.Locals, params: { id: "c1" } } as never))
		);
		expect(status).toBe(502);
		expect(reason).toBe("service_unreachable");
	});

	it("upstream ok → 200, ok:true", async () => {
		const res = await postConfirm(200);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
