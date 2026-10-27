import { describe, expect, it, vi } from "vitest";
import { runMcpTool } from "./executor";
import type { McpCallOptions, McpCallResult } from "./client";

describe("runMcpTool — the shared tool-execution seam (CUR-1017)", () => {
	it("returns a typed success result on a successful call", async () => {
		const call = vi.fn().mockResolvedValue({ kind: "text", text: "hello" });
		await expect(runMcpTool({ call }, "read_aloud", { text: "hi" })).resolves.toEqual({
			ok: true,
			result: "hello",
		});
		expect(call).toHaveBeenCalledWith("read_aloud", { text: "hi" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
	});

	it("passes through an input_required result rather than treating it as success or failure", async () => {
		const call = vi.fn().mockResolvedValue({
			kind: "input_required",
			inputRequests: { q1: { message: "What's your name?" } },
			requestState: "opaque-state",
		});
		await expect(runMcpTool({ call }, "ask_something", {})).resolves.toEqual({
			ok: "input_required",
			inputRequired: {
				kind: "input_required",
				inputRequests: { q1: { message: "What's your name?" } },
				requestState: "opaque-state",
			},
		});
	});

	it("normalizes a thrown Error into a typed failure rather than rejecting", async () => {
		const call = vi.fn().mockRejectedValue(new Error("Space is asleep"));
		await expect(runMcpTool({ call }, "read_aloud", {})).resolves.toEqual({
			ok: false,
			reason: "Space is asleep",
		});
	});

	it("normalizes a non-Error throw (e.g. a string) into a typed failure too", async () => {
		const call = vi.fn().mockRejectedValue("connection reset");
		await expect(runMcpTool({ call }, "read_aloud", {})).resolves.toEqual({
			ok: false,
			reason: "connection reset",
		});
	});

	// A transport that never settles, and ignores the abort, must still not hold the caller. (CUR-4627)
	it("a call whose transport never settles ends at its timeout as a timeout, not a hang or a failure", async () => {
		const call = vi.fn().mockReturnValue(new Promise(() => {}));
		await expect(runMcpTool({ call }, "run_code", {}, { timeoutMs: 20 })).resolves.toEqual({ ok: "timeout", aborted: false });
		expect(call.mock.calls[0][2].signal.aborted, "the SDK request was not told to stop").toBe(true);
	});

	it("an abort from the caller ends a pending call at once and says it was aborted", async () => {
		const call = vi.fn().mockReturnValue(new Promise(() => {}));
		const ctrl = new AbortController();
		const running = runMcpTool({ call }, "run_code", {}, { timeoutMs: 60_000, signal: ctrl.signal });
		ctrl.abort();
		await expect(running).resolves.toEqual({ ok: "timeout", aborted: true });
	});

	it("an SDK rejection caused by the abort reads as the timeout, not as a server failure", async () => {
		const call = vi.fn(
			(_n: string, _a: Record<string, unknown>, o?: McpCallOptions) =>
				new Promise<McpCallResult>((_r, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("AbortError"))))
		);
		await expect(runMcpTool({ call }, "run_code", {}, { timeoutMs: 20 })).resolves.toEqual({ ok: "timeout", aborted: false });
	});
});
