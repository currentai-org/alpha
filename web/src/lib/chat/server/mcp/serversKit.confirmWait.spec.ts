// A write the person confirms gets its own time to run, however long they took to press Allow.
// The route holds the turn's clock while a confirmation card is open (genDeadline.setHumanWaiting),
// so the kit's budget for the call must not count that wait either, or a 25 s read of the card
// leaves the approved write a call_timeout before it ever starts.
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/database", () => ({ collections: {} }));

const { mcpServersKit, ANSWER_MARGIN_MS } = await import("./serversKit");
type ServerTool = import("./serverTools").ServerTool;
type McpServerConfig = import("./servers").McpServerConfig;
type ConfirmStore = import("./confirm").ConfirmStore;

const WRITE: ServerTool = {
	fnName: "stub__set_setting",
	server: "stub",
	tool: "set_setting",
	sha256: "x",
	definition: {
		type: "function",
		function: { name: "stub__set_setting", parameters: { type: "object", properties: {} } },
	},
	annotations: { readOnlyHint: false },
} as ServerTool;

const SERVER: McpServerConfig = {
	name: "stub",
	url: "https://stub.example/mcp/",
	headers: {},
	origin: "https://stub.example",
	fetch: async () => new Response(null),
};

const CALL = { id: "w1", name: WRITE.fnName, arguments: JSON.stringify({ key: "accent_color", value: "orange" }) };

/** The kit on a hand-driven clock: `clock.t` is now, and the confirmation is answered after `waitMs`. */
function kitWithClock(waitMs: number, turnLeftMs: number) {
	const clock = { t: 1_000_000 };
	let calls = 0;
	let answeredAt: number | undefined;
	const confirm: ConfirmStore = {
		open: async () => {
			answeredAt = clock.t + waitMs;
			return "c1";
		},
		read: async () => (answeredAt !== undefined && clock.t >= answeredAt ? "accept" : undefined),
		expire: async () => false,
	};
	const kit = mcpServersKit({
		tools: [WRITE],
		servers: [SERVER],
		policies: { [WRITE.fnName]: "ask" },
		shownServers: ["stub"],
		confirm,
		confirmWindowMs: waitMs + 60_000,
		now: () => clock.t,
		sleep: async (ms: number) => {
			clock.t += ms;
		},
		turnDeadlineAt: clock.t + turnLeftMs,
		connect: async () => ({
			tools: [],
			openaiTools: [],
			call: async () => {
				calls++;
				return { kind: "text" as const, text: "accent_color is now orange" };
			},
			close: async () => {},
		}),
	});
	return { kit, calls: () => calls };
}

describe("a confirmed write's budget", () => {
	it("a write the person allows after a wait longer than the turn had left still runs, and its result reaches the answer", async () => {
		// 20 s of turn left, less the answer's margin, is 10 s of budget; the person reads the card for 25 s.
		const { kit, calls } = kitWithClock(25_000, ANSWER_MARGIN_MS + 10_000);
		for await (const _ of kit.beforeRun([CALL])) void _;
		const res = await kit.run(CALL);
		expect(calls(), "the approved write never reached the server").toBe(1);
		expect(JSON.stringify(res)).toContain("accent_color is now orange");
		expect(JSON.stringify(res)).not.toMatch(/timed out/);
	});
});
