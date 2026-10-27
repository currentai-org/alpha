import { describe, it, expect, vi, beforeEach } from "vitest";

// firstKey reads through the `config` proxy, not process.env — mock it with a mutable object we can
// vary per test. The module-level `warned` Set dedupes per label, so every test also resets modules.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const warn = vi.fn();
const info = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) } }));

async function load() {
	vi.resetModules();
	return (await import("./firstKey")).firstKey;
}

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	warn.mockReset();
	info.mockReset();
});

describe("firstKey", () => {
	it("returns the preferred key silently when it is set", async () => {
		const firstKey = await load();
		Object.assign(cfg, { A: "value-a", B: "value-b" });
		expect(firstKey(["A", "B"], "test")).toBe("value-a");
		expect(warn).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
	});

	it("warns when a credential chain falls past its preferred key", async () => {
		const firstKey = await load();
		Object.assign(cfg, { B: "value-b" });
		expect(firstKey(["A", "B"], "cred")).toBe("value-b");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(info).not.toHaveBeenCalled();
	});

	it("warns once per label, not once per call", async () => {
		const firstKey = await load();
		Object.assign(cfg, { B: "value-b" });
		firstKey(["A", "B"], "cred");
		firstKey(["A", "B"], "cred");
		firstKey(["A", "B"], "cred");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("warns when every key is empty", async () => {
		const firstKey = await load();
		expect(firstKey(["A", "B"], "cred")).toBe("");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("stays silent on an all-empty result when allowEmpty is set", async () => {
		const firstKey = await load();
		expect(firstKey(["A", "B"], "optional", { allowEmpty: true })).toBe("");
		expect(warn).not.toHaveBeenCalled();
	});

	// An OVERRIDE key whose normal state is unset must not warn on every cold
	// start: that describes correct operation at the level you filter to when something is broken.
	it("logs the fall-through at info, not warn, when the preferred key is an optional override", async () => {
		const firstKey = await load();
		Object.assign(cfg, { B: "value-b" });
		expect(firstKey(["A", "B"], "override", { allowEmpty: true, optionalPreferred: true })).toBe(
			"value-b"
		);
		expect(warn).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("optionalPreferred does not suppress the all-empty warn on its own", async () => {
		const firstKey = await load();
		expect(firstKey(["A", "B"], "override", { optionalPreferred: true })).toBe("");
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
