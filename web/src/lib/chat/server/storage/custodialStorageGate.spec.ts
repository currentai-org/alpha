import { beforeEach, describe, expect, it, vi } from "vitest";

const { flagEnabledForUser, flagEnabledOr } = vi.hoisted(() => ({ flagEnabledForUser: vi.fn(), flagEnabledOr: vi.fn() }));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledForUser, flagEnabledOr }));
vi.mock("$lib/chat/server/deployEnv", () => ({ deployEnv: () => "preview" }));
// A bucket resolves, so the gate reaches PostHog; with none it is off whatever the flag says, which
// custodialStorage.spec.ts covers.
vi.mock("./custodialBackend", () => ({ custodialBackendChosen: () => true }));

const { custodialStorageViewEnabledForUser, CUSTODIAL_STORAGE_VIEW_FLAG } = await import("./custodialStorageGate");

beforeEach(() => {
	flagEnabledForUser.mockReset();
});

describe("custodialStorageViewEnabledForUser", () => {
	it("is off when PostHog cannot answer: the code default it passes is off", async () => {
		flagEnabledForUser.mockImplementation(async (_k: string, _id: string, _p: unknown, fallback?: () => boolean) => {
			if (!fallback) throw new Error("custodialStorageViewEnabledForUser passed no code default");
			return fallback();
		});
		expect(await custodialStorageViewEnabledForUser("acct-1")).toBe(false);
	});

	it("returns PostHog's answer for the account, evaluated against its real id", async () => {
		flagEnabledForUser.mockResolvedValue(true);
		expect(await custodialStorageViewEnabledForUser("acct-1")).toBe(true);
		expect(flagEnabledForUser).toHaveBeenCalledWith(
			CUSTODIAL_STORAGE_VIEW_FLAG,
			"acct-1",
			{ env: "preview" },
			expect.any(Function)
		);
	});
});
