// A run-code call that waits on a full sandbox host shows "Waiting for a free sandbox…" while it is
// still pending. Run through the real SDK client against the full-host stand-in (sandboxWaitStub.ts), whose
// reply is the SSE stream agent-service sends: one progress notification, then the result. (CUR-4584)
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));

const { sandboxWaitStubServer, sandboxWaitFetch, SANDBOX_WAIT_STUB_STDOUT } = await import("./sandboxWaitStub");
const { listServerTools } = await import("./serverTools");
const { mcpServersKit } = await import("./serversKit");
const { framesWhile } = await import("../endpoints/toolFrames");
const { originScopedFetch } = await import("./servers");
const { sandboxServerFor } = await import("./sandboxServer");

// The config the turn is offered for a signed-in account; the stand-in replaces only its address and fetch.
const OFFERED = sandboxServerFor("conv-1", { user: { _id: "u1" } } as unknown as App.Locals, {
	enabled: () => true,
	url: () => "https://agent.example",
	token: () => "t",
})!;

const RUN = { id: "c1", name: "sandbox__run_code", arguments: JSON.stringify({ code: "print(2**43)" }) };

async function kitFor(server: ReturnType<typeof sandboxWaitStubServer>) {
	const servers = [server];
	const tools = await listServerTools(servers);
	return mcpServersKit({ tools, servers, policies: { [RUN.name]: "allow" } });
}

describe("a sandbox call waiting for a free slot (CUR-4584)", () => {
	it("shows the wait while the call is pending, then ends it, and the call still answers with real output", async () => {
		const kit = await kitFor(sandboxWaitStubServer(OFFERED, 50));
		const running = kit.run(RUN);
		const seen: unknown[] = [];
		let settledBeforeWaiting = true;
		let settled = false;
		void running.then(() => (settled = true));
		for await (const frame of framesWhile(running, kit.frames!)) {
			if (frame.sandboxWait === "waiting") settledBeforeWaiting = settled;
			seen.push(frame);
		}
		const res = await running;
		expect(seen).toEqual([{ sandboxWait: "waiting" }, { sandboxWait: "ready" }]);
		expect(settledBeforeWaiting, "the wait was shown only after the call had returned").toBe(false);
		expect(res.mcpCall?.outcome).toBe("ok");
		expect(res.content).toContain(SANDBOX_WAIT_STUB_STDOUT);
	});

	it("a server whose progress is not a sandbox wait shows nothing, whatever it sends", async () => {
		const plain = { ...sandboxWaitStubServer(OFFERED, 0), progressIsSandboxWait: false };
		const kit = await kitFor(plain);
		const res = await kit.run(RUN);
		expect(kit.frames!.take()).toEqual([]);
		expect(res.mcpCall?.outcome).toBe("ok");
	});

	it("a call the server never answers in time still ends the wait it showed", async () => {
		const origin = "https://sandbox-wait-stub.e2e.invalid";
		const hung = {
			...sandboxWaitStubServer(OFFERED, 0),
			fetch: originScopedFetch(origin, sandboxWaitFetch(0, () => new Promise(() => {}))),
			callTimeoutMs: 100,
		};
		const kit = await kitFor(hung);
		const res = await kit.run(RUN);
		// The call ran out of time, and the model is told so rather than "unreachable". (CUR-4627)
		expect(res.mcpCall?.outcome).toBe("call_timeout");
		expect(kit.frames!.take()).toEqual([{ sandboxWait: "waiting" }, { sandboxWait: "ready" }]);
	});
});

describe("the sandbox_host_full fault (CUR-4584)", () => {
	const ctx = {
		conv: { _id: { toString: () => "conv-9" } as never },
		locals: { sessionId: "v", user: { _id: "a" } } as unknown as App.Locals,
	};
	function realSandbox() {
		const asked: string[] = [];
		const server = {
			name: "sandbox",
			url: "https://agent.example.test/mcp/",
			headers: {},
			origin: "https://agent.example.test",
			fetch: async (url: string | URL) => {
				asked.push(String(url));
				return new Response(null, { status: 500 });
			},
		};
		return { server, asked };
	}

	it("puts the full-host stand-in where the sandbox is offered, and never asks the real one", async () => {
		const { mcpServersKitForTurn } = await import("./turnKit");
		const real = realSandbox();
		const kit = await mcpServersKitForTurn({ ...ctx, faultInjection: "sandbox_host_full" }, async () => ({}), async () => [], {
			withSandbox: true,
			sandboxFor: () => real.server,
			handoffEnabled: () => false,
		});
		expect(kit?.definitions.map((d) => d.function.name)).toEqual(["sandbox__run_code"]);
		expect(kit?.frames, "the kit has no frames, so the wait would never reach the live line").toBeDefined();
		expect(real.asked).toEqual([]);
	});

	it("leaves a turn with no sandbox offered without one", async () => {
		const { mcpServersKitForTurn } = await import("./turnKit");
		const real = realSandbox();
		const kit = await mcpServersKitForTurn({ ...ctx, faultInjection: "sandbox_host_full" }, async () => ({}), async () => [], {
			sandboxFor: () => real.server,
		});
		expect(kit).toBeUndefined();
	});
});
