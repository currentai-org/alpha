import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what connectMcp actually constructs/registers, without a real network connection.
const { clientCtorArgs, handlers, listToolsMock, callToolMock, connectMock } = vi.hoisted(() => ({
	clientCtorArgs: [] as unknown[][],
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	listToolsMock: vi.fn().mockResolvedValue({ tools: [] }),
	callToolMock: vi.fn(),
	connectMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/client", () => ({
	Client: class {
		constructor(...args: unknown[]) {
			clientCtorArgs.push(args);
		}
		connect = connectMock;
		listTools = listToolsMock;
		callTool = callToolMock;
		close = vi.fn().mockResolvedValue(undefined);
		setRequestHandler(method: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(method, handler);
		}
	},
	SSEClientTransport: class {},
	StreamableHTTPClientTransport: class {},
	isInputRequiredResult: (res: unknown) =>
		!!res && typeof res === "object" && (res as { resultType?: string }).resultType === "input_required",
}));

const { elicitationEnabledMock } = vi.hoisted(() => ({ elicitationEnabledMock: vi.fn(() => false) }));
vi.mock("./elicitationConfig", () => ({ elicitationEnabled: () => elicitationEnabledMock() }));

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
	clientCtorArgs.length = 0;
	handlers.clear();
	listToolsMock.mockClear().mockResolvedValue({ tools: [] });
	callToolMock.mockReset();
	elicitationEnabledMock.mockReturnValue(false);
});

describe("connectMcp — elicitation capability gating (CUR-1017)", () => {
	it("advertises no elicitation capability, and registers no request handler, when the flag is off", async () => {
		const { connectMcp } = await import("./client");
		await connectMcp("https://example.hf.space/mcp");

		const [, options] = clientCtorArgs[0] as [unknown, { capabilities: Record<string, unknown> }];
		expect(options.capabilities).toEqual({});
		expect(handlers.has("elicitation/create")).toBe(false);
	});

	it("advertises both elicitation modes, spelled out, when the flag is on", async () => {
		elicitationEnabledMock.mockReturnValue(true);
		const { connectMcp } = await import("./client");
		await connectMcp("https://example.hf.space/mcp");

		const [, options] = clientCtorArgs[0] as [unknown, { capabilities: Record<string, unknown> }];
		expect(options.capabilities).toEqual({ elicitation: { form: {}, url: {} } });
	});

	it("registers a handler for elicitation/create that ALWAYS declines — this repo doesn't support the blocking 2025-era flow", async () => {
		elicitationEnabledMock.mockReturnValue(true);
		const { connectMcp } = await import("./client");
		await connectMcp("https://example.hf.space/mcp");

		const handler = handlers.get("elicitation/create");
		expect(handler).toBeDefined();
		await expect(handler?.()).resolves.toEqual({ action: "decline" });
	});

	it("always sets inputRequired.autoFulfill: false, regardless of the elicitation flag", async () => {
		const { connectMcp } = await import("./client");
		await connectMcp("https://example.hf.space/mcp");
		const [, options] = clientCtorArgs[0] as [unknown, { inputRequired: { autoFulfill: boolean } }];
		expect(options.inputRequired).toEqual({ autoFulfill: false });
	});
});

describe("McpConnection.call — input_required detection (CUR-1017)", () => {
	it("returns a text result for an ordinary tool call", async () => {
		callToolMock.mockResolvedValue({ content: [{ type: "text", text: "hello" }] });
		const { connectMcp } = await import("./client");
		const conn = await connectMcp("https://example.hf.space/mcp");
		await expect(conn.call("some_tool", {})).resolves.toEqual({ kind: "text", text: "hello" });
	});

	it("returns an input_required result rather than treating it as ordinary text", async () => {
		callToolMock.mockResolvedValue({
			resultType: "input_required",
			inputRequests: { q1: { message: "more info please" } },
			requestState: "opaque",
		});
		const { connectMcp } = await import("./client");
		const conn = await connectMcp("https://example.hf.space/mcp");
		await expect(conn.call("some_tool", {})).resolves.toEqual({
			kind: "input_required",
			inputRequests: { q1: { message: "more info please" } },
			requestState: "opaque",
		});
	});

	it("passes allowInputRequired: true so the driver never blocks on it", async () => {
		callToolMock.mockResolvedValue({ content: [] });
		const { connectMcp } = await import("./client");
		const conn = await connectMcp("https://example.hf.space/mcp");
		await conn.call("some_tool", { a: 1 });
		expect(callToolMock).toHaveBeenCalledWith(
			expect.objectContaining({ name: "some_tool" }),
			expect.objectContaining({ allowInputRequired: true })
		);
	});
});
