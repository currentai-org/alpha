// Shared test fixtures for CUR-1017's elicitation mechanism — used by both elicitation.spec.ts and
// db/__tests__/deleteConversations.spec.ts, so the fixture lives once rather than being duplicated
// per test file (jscpd's audit:dup:check flags exactly that).
import type { McpCallResult } from "./client";
import type { ConfirmStore } from "./confirm";

// The SDK's real InputRequest type is a strict discriminated union a plain test fixture object
// doesn't structurally satisfy — openDurableElicitation only ever inspects this at runtime via
// normalizeElicitationRequest (takes `unknown`), so the cast here is test-fixture noise, not a
// runtime type hole.
export function formInputRequired(
	overrides?: Partial<{ message: string }>
): Extract<McpCallResult, { kind: "input_required" }> {
	return {
		kind: "input_required",
		inputRequests: {
			q1: {
				message: overrides?.message ?? "What's your name?",
				requestedSchema: { properties: { name: { type: "string" } }, required: ["name"] },
			},
		},
		requestState: "opaque-state",
	} as unknown as Extract<McpCallResult, { kind: "input_required" }>;
}

/** A confirmation store whose answer the test gives, and which records each card it was asked to
 *  open. Shared by the MCP servers specs so the double is defined once. */
export function fakeConfirm(answer: () => string | undefined): ConfirmStore & { opened: string[] } {
	const opened: string[] = [];
	return {
		opened,
		async open({ tool }) {
			opened.push(tool);
			return `confirm-${opened.length}`;
		},
		async read() {
			return answer();
		},
		async expire() {
			return answer() === undefined;
		},
	};
}
