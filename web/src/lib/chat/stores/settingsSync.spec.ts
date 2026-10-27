import { describe, expect, it } from "vitest";
import { createSyncTracker } from "./settingsSync";

const saved = { streamingMode: "smooth", directPaste: false, customPrompts: {} as Record<string, string> };

describe("createSyncTracker (CUR-1643)", () => {
	it("names only the changed field, so a write cannot carry a stale copy of another", () => {
		const sync = createSyncTracker(saved);
		expect(sync.dirty({ ...saved, directPaste: true })).toEqual({ directPaste: true });
	});

	it("sees a nested object mutated in place, which an identity check would miss", () => {
		const current = { ...saved, customPrompts: {} as Record<string, string> };
		const sync = createSyncTracker(current);
		current.customPrompts["m"] = "be brief";
		expect(sync.dirty(current)).toEqual({ customPrompts: { m: "be brief" } });
	});

	it("keeps a field dirty after a failed save, so the next save resends it", async () => {
		const sync = createSyncTracker(saved);
		const current = { ...saved, streamingMode: "raw" };
		expect(await sync.save(sync.dirty(current), async () => false)).toBe(false);
		expect(sync.dirty(current)).toEqual({ streamingMode: "raw" });
	});

	it("clears a field once a save succeeds", async () => {
		const sync = createSyncTracker(saved);
		const current = { ...saved, streamingMode: "raw" };
		await sync.save(sync.dirty(current), async () => true);
		expect(sync.dirty(current)).toEqual({});
	});

	// The answer-preference lane records its own saves and reads back what the server took. (CUR-3929)
	it("reports the confirmed value of a key, and undefined once a reset was saved", () => {
		const sync = createSyncTracker<{ tone?: string; directPaste: boolean }>({ tone: "plain", directPaste: false });
		expect(sync.confirmed("tone")).toBe("plain");
		sync.recordSaved({ tone: undefined });
		expect(sync.confirmed("tone")).toBeUndefined();
		sync.recordSaved({ tone: "formal" });
		expect(sync.confirmed("tone")).toBe("formal");
	});

	it("treats an unset field as equal to another unset, so a reset that was saved is not dirty", () => {
		const sync = createSyncTracker<{ tone?: string }>({ tone: "plain" });
		sync.recordSaved({ tone: undefined });
		expect(sync.dirty({ tone: undefined })).toEqual({});
		expect(sync.dirty({})).toEqual({});
	});
});
