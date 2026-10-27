import { beforeEach, describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({ findOne: vi.fn(async (): Promise<unknown> => null) }));
vi.mock("$lib/chat/server/database", () => ({ collections: { settings: row } }));
vi.mock("$lib/chat/server/auth", () => ({ authCondition: () => ({ sessionId: "s" }) }));
const killSwitch = vi.hoisted(() => ({ autoMode: undefined as boolean | undefined }));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (key: string, fallback: () => boolean) =>
		key === "agent-auto-mode" && killSwitch.autoMode !== undefined ? killSwitch.autoMode : fallback(),
}));

const { agentAutoApproveFor } = await import("./agentConfirmUi");
const locals = { sessionId: "s" } as unknown as App.Locals;

describe("agentAutoApproveFor", () => {
	beforeEach(() => {
		row.findOne.mockReset();
		killSwitch.autoMode = undefined;
	});

	it("runs auto mode by default, for a person with no settings row", async () => {
		row.findOne.mockResolvedValueOnce(null);
		expect(await agentAutoApproveFor(locals)).toBe(true);
	});

	it("runs auto mode while the ask-every-step switch is unset or off", async () => {
		row.findOne.mockResolvedValueOnce({});
		expect(await agentAutoApproveFor(locals)).toBe(true);
		row.findOne.mockResolvedValueOnce({ agentAskEveryStep: false });
		expect(await agentAutoApproveFor(locals)).toBe(true);
	});

	it("asks before every step only when the person turned the switch on", async () => {
		row.findOne.mockResolvedValueOnce({ agentAskEveryStep: true });
		expect(await agentAutoApproveFor(locals)).toBe(false);
	});

	it("runs auto mode (fails open to the default, and logs) when the settings read throws", async () => {
		row.findOne.mockRejectedValueOnce(new Error("db down"));
		expect(await agentAutoApproveFor(locals)).toBe(true);
	});

	it("asks everyone, whatever their own setting, when the agent-auto-mode kill switch is off", async () => {
		killSwitch.autoMode = false;
		row.findOne.mockResolvedValue({ agentAskEveryStep: false });
		expect(await agentAutoApproveFor(locals)).toBe(false);
		expect(await agentAutoApproveFor(undefined)).toBe(false);
	});
});
