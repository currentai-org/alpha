// The one seam every tool-execution path calls through, instead of touching an McpConnection
// directly. Thin today — it owns nothing timeout/budget-shaped yet, since neither exists on this
// codebase's tool-call path — but the point is that they land HERE, inside this module, once
// CUR-1017's later slices build them, rather than each caller (today's bare router, a future
// sub-agent) growing its own copy of "call a tool, normalize the outcome."
//
// Deliberately does NOT own connect/close: the caller already holds an open connection (index.ts
// connects once, lists tools for routing, then calls the chosen one on the SAME connection) —
// opening a second connection here would double the Space-wake cost this file's timing budgets
// are built around. This wraps only the call.
import type { McpCallOptions, McpConnection, McpCallResult } from "./client";

export type McpToolExecution =
	| { ok: true; result: string }
	| { ok: false; reason: string }
	// The tool ran and answered with `isError` (CUR-2645). Unlike a thrown failure, the server
	// said why, and `message` carries that reason so the answer can report it instead of
	// grounding on it.
	| { ok: "tool_error"; message: string }
	// A 2026-era server needs more input before it can finish (CUR-1017) — distinct from a
	// failure: nothing here went wrong, the call is just not done. The caller parks it.
	| { ok: "input_required"; inputRequired: Extract<McpCallResult, { kind: "input_required" }> }
	// The call did not answer before `timeoutMs`, or `signal` aborted it. Nothing waits on it
	// any more; the caller says so plainly instead of holding the turn. (CUR-4627)
	| { ok: "timeout"; aborted: boolean };

/** The SDK's own default (DEFAULT_REQUEST_TIMEOUT_MSEC), applied here so a hung transport cannot outlast it. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** Call `toolName` on an already-connected `conn`, normalizing a thrown failure into a typed
 *  result instead of letting it propagate. Never throws.
 *
 *  The call ends at `timeoutMs` (default the SDK's 60 s) or when `signal` aborts, whichever is
 *  first, even if the transport underneath never settles. The abort reaches the SDK request too, so it (CUR-4627)
 *  stops waiting on the server rather than leaking a pending request. */
export async function runMcpTool(
	conn: Pick<McpConnection, "call">,
	toolName: string,
	args: Record<string, unknown>,
	opts?: McpCallOptions
): Promise<McpToolExecution> {
	const { signal: outer, ...rest } = opts ?? {};
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
	const ctrl = new AbortController();
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		ctrl.abort(outer?.reason);
	};
	if (outer?.aborted) return { ok: "timeout", aborted: true };
	outer?.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ended = new Promise<"ended">((resolve) => {
		timer = setTimeout(() => {
			ctrl.abort(new Error(`[mcp] ${toolName} timed out after ${timeoutMs}ms`));
			resolve("ended");
		}, timeoutMs);
		ctrl.signal.addEventListener("abort", () => resolve("ended"), { once: true });
	});
	try {
		const callOpts: McpCallOptions = { ...rest, timeoutMs, signal: ctrl.signal };
		const res = await Promise.race([conn.call(toolName, args, callOpts), ended]);
		if (res === "ended") return { ok: "timeout", aborted };
		if (res.kind === "input_required") {
			return { ok: "input_required", inputRequired: res };
		}
		if (res.kind === "error") {
			return { ok: "tool_error", message: res.text || "The tool reported an error with no message." };
		}
		return { ok: true, result: res.text };
	} catch (e) {
		// The SDK rejects its request when the abort reaches it; that is still the timeout, not a failure.
		if (ctrl.signal.aborted) return { ok: "timeout", aborted };
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onAbort);
	}
}
