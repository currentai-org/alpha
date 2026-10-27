import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// This is the CLIENT STORE (stores/agentMode.ts) — off/auto/on, localStorage-persisted, not the SERVER
// GATE of the same base name (server/agentMode.ts, agentModeEnabled/agentModeEnabledForUser). Easy to
// open the wrong file; they test unrelated things.

vi.mock("$app/environment", () => ({ building: false, dev: false, browser: true, version: "test" }));

const KEY = "ap:agentMode";

function stubStorage(initial: Record<string, string> = {}) {
	const backing = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
		setItem: (k: string, v: string) => {
			backing.set(k, v);
		},
		removeItem: (k: string) => {
			backing.delete(k);
		},
	});
	return backing;
}

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.stubGlobal("localStorage", undefined); // ensure a clean slate each test re-stubs explicitly
});

describe("applyServerDefault — seeds a cleared tester's first-ever visit, never an explicit choice", () => {
	it("sets the store to the server default when localStorage has never been written", async () => {
		stubStorage(); // KEY absent entirely
		const { agentMode, applyServerDefault } = await import("./agentMode");
		applyServerDefault("auto");
		expect(get(agentMode)).toBe("auto");
	});

	it("does not override an explicit past 'off' — a deliberate opt-out is not 'never chosen'", async () => {
		stubStorage({ [KEY]: "off" });
		const { agentMode, applyServerDefault } = await import("./agentMode");
		applyServerDefault("auto");
		expect(get(agentMode)).toBe("off");
	});

	it("does not override an explicit past 'on' either — any prior write blocks the default, not just off", async () => {
		stubStorage({ [KEY]: "on" });
		const { agentMode, applyServerDefault } = await import("./agentMode");
		applyServerDefault("auto");
		expect(get(agentMode)).toBe("on");
	});

	it("is a no-op when the server default itself is off — nothing to default a hidden toggle to", async () => {
		stubStorage(); // KEY absent
		const { agentMode, applyServerDefault } = await import("./agentMode");
		applyServerDefault("off");
		expect(get(agentMode)).toBe("off"); // unchanged from initial()'s own default
	});

	// A throwing localStorage (private mode / quota) reads the same as "never written" — readStored()
	// catches at module load and treats it as no signal either way. Nothing persists across a session in
	// that mode regardless, so applying the default fresh each time is more useful than withholding it.
	it("applies the default when localStorage throws (private mode) — read failure looks like never-written", async () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new DOMException("blocked");
			},
			setItem: () => {
				throw new DOMException("blocked");
			},
		});
		const { agentMode, applyServerDefault } = await import("./agentMode");
		expect(() => applyServerDefault("auto")).not.toThrow();
		expect(get(agentMode)).toBe("auto");
	});

	// On a genuinely FIRST-EVER visit, `storedAtLoad` is frozen at MODULE load — before any
	// component, and therefore before any click, can exist — so it cannot by itself detect a click that
	// lands between module load and this call. In the real app this call runs from ChatShell's onMount,
	// which Svelte fires AFTER its child components' onMount (the composer's Agent toggle among them),
	// so the toggle is clickable before this seed runs. A toggle clicked to "on" in that window reads
	// "Agent: on" in the DOM, then the next request carries `agentMode:"auto"` if this function resets
	// it. Simulated here as a manual `agentMode.set` between module import
	// and the call, standing in for "the user's own click already landed." (CUR-1067)
	it("does not clobber a click that already landed before this call runs, even on a first-ever visit", async () => {
		stubStorage(); // KEY absent entirely — a genuine first visit, storedAtLoad === null
		const { agentMode, applyServerDefault } = await import("./agentMode");
		agentMode.set("on"); // stands in for the toggle click Svelte let through before onMount fired
		applyServerDefault("auto");
		expect(get(agentMode)).toBe("on");
	});
});
