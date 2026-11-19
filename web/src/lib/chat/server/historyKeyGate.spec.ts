import { beforeEach, describe, expect, it, vi } from "vitest";

// historyKeyGate: the flag decides, and a deployment that cannot keep a key refuses loudly
// rather than offering a surface whose PUT would fail.

const m = vi.hoisted(() => ({
	flag: vi.fn<(key: string, fallback: () => boolean) => boolean>(),
	configured: vi.fn(() => true),
	guests: vi.fn(() => true),
	error: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("./flags", () => ({ flagEnabledOr: m.flag }));
vi.mock("./logger", () => ({ logger: { error: m.error, warn: m.warn, info: vi.fn() } }));
vi.mock("./storage/custodialStorage", () => ({ custodialStorageConfigured: m.configured }));
vi.mock("./storage/custodialStorageGate", () => ({ custodialStorageForGuestsEnabled: m.guests }));

async function freshGate() {
	vi.resetModules();
	return import("./historyKeyGate");
}

beforeEach(() => {
	m.flag.mockReset().mockImplementation((_k, fallback) => fallback());
	m.configured.mockReset().mockReturnValue(true);
	m.guests.mockReset().mockReturnValue(true);
	m.error.mockReset();
	m.warn.mockReset();
});

describe("historyKeyEnrollmentOffered", () => {
	it("is off when PostHog cannot answer: the code default it passes is off", async () => {
		const { historyKeyEnrollmentOffered, HISTORY_KEY_ENROLLMENT_FLAG } = await freshGate();
		expect(historyKeyEnrollmentOffered(true)).toBe(false);
		expect(m.flag).toHaveBeenCalledWith(HISTORY_KEY_ENROLLMENT_FLAG, expect.any(Function));
	});

	it("is on for a signed-in account and a guest when the flag is on and storage is there", async () => {
		m.flag.mockReturnValue(true);
		const { historyKeyEnrollmentOffered } = await freshGate();
		expect(historyKeyEnrollmentOffered(true)).toBe(true);
		expect(historyKeyEnrollmentOffered(false)).toBe(true);
	});

	it("refuses loudly with the flag on and no custodial storage: off, and one error logged per instance", async () => {
		m.flag.mockReturnValue(true);
		m.configured.mockReturnValue(false);
		const { historyKeyEnrollmentOffered } = await freshGate();
		expect(historyKeyEnrollmentOffered(true)).toBe(false);
		expect(historyKeyEnrollmentOffered(false)).toBe(false);
		expect(m.error).toHaveBeenCalledTimes(1);
		expect(m.error.mock.calls[0][0]).toMatchObject({ event: "history-key-enrollment-no-storage" });
	});

	it("logs nothing about storage while the flag is off, since nothing was offered", async () => {
		m.configured.mockReturnValue(false);
		const { historyKeyEnrollmentOffered } = await freshGate();
		expect(historyKeyEnrollmentOffered(true)).toBe(false);
		expect(m.error).not.toHaveBeenCalled();
	});

	it("offers a guest nothing where guests may not keep a key, and still offers the account", async () => {
		m.flag.mockReturnValue(true);
		m.guests.mockReturnValue(false);
		const { historyKeyEnrollmentOffered } = await freshGate();
		expect(historyKeyEnrollmentOffered(false)).toBe(false);
		expect(historyKeyEnrollmentOffered(true)).toBe(true);
		expect(m.warn).toHaveBeenCalledTimes(1);
	});
});
