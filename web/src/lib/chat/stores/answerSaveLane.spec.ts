import { describe, expect, it } from "vitest";
import { createAnswerSaveLane } from "./answerSaveLane";

type WireBody = Record<string, unknown>;

// The ordering and recovery rules of the serial save lane, each as the person would see it on
// the Personalization page. The server is a hand-driven stub so a request can be held open or failed. (CUR-3929)
type Prefs = { tone?: "plain" | "neutral" | "formal"; answerLength?: "short" | "normal" | "detailed" };

function harness(opts: { fail?: (body: WireBody, n: number) => boolean } = {}) {
	const store: Prefs = {};
	const confirmed = new Map<string, unknown>();
	const bodies: WireBody[] = [];
	const resolvers: Array<(ok: boolean) => void> = [];
	const events: string[] = [];
	const lane = createAnswerSaveLane<Prefs>({
		post: (body) => {
			bodies.push(body);
			return new Promise<boolean>((resolve) => {
				const n = bodies.length;
				resolvers.push((ok) => resolve(ok && !opts.fail?.(body, n)));
			});
		},
		confirmed: (key) => confirmed.get(key) as never,
		recordSaved: (patch) => {
			for (const [key, value] of Object.entries(patch)) confirmed.set(key, value);
		},
		apply: (patch) => Object.assign(store, patch),
		onSaved: (saved) => events.push(`saved:${Object.keys(saved).sort().join(",")}`),
		onFailed: (restored) => events.push(`failed:${Object.keys(restored).sort().join(",")}`),
	});
	/** Let the oldest unanswered request complete. */
	const release = async (ok = true) => {
		const next = resolvers.shift();
		if (!next) throw new Error("no request in flight");
		next(ok);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { lane, store, bodies, release, events, confirmed };
}

describe("createAnswerSaveLane (CUR-3929)", () => {
	it("takes the value in the store at once, before the request answers", () => {
		const h = harness();
		void h.lane.set({ tone: "plain" });
		expect(h.store.tone).toBe("plain");
		expect(h.bodies).toEqual([{ tone: "plain" }]);
	});

	it("sends a reset as null on the wire and holds undefined in the store", () => {
		const h = harness();
		void h.lane.set({ tone: undefined });
		expect("tone" in h.store && h.store.tone === undefined).toBe(true);
		expect(h.bodies).toEqual([{ tone: null }]);
	});

	it("sends one request at a time, in order: a reset then a choice reach the server in that order", async () => {
		const h = harness();
		void h.lane.set({ tone: undefined });
		void h.lane.set({ tone: "formal" });
		expect(h.bodies, "the second change went out while the first was in flight").toHaveLength(1);
		expect(h.store.tone).toBe("formal");
		await h.release();
		expect(h.bodies).toEqual([{ tone: null }, { tone: "formal" }]);
		await h.release();
		expect(h.events).toEqual(["saved:tone", "saved:tone"]);
		expect(h.confirmed.get("tone")).toBe("formal");
	});

	it("coalesces several changes made during one request into one body with the latest values", async () => {
		const h = harness();
		void h.lane.set({ tone: "plain" });
		void h.lane.set({ tone: "formal" });
		void h.lane.set({ answerLength: "short" });
		void h.lane.set({ tone: "neutral" });
		await h.release();
		expect(h.bodies).toEqual([{ tone: "plain" }, { tone: "neutral", answerLength: "short" }]);
		await h.release();
		expect(h.bodies).toHaveLength(2);
	});

	it("restores a failed key to the confirmed value, not to the value before the call", async () => {
		// Saved Neutral; Plain fails, then Formal fails: the row reads Neutral, what the database holds.
		const h = harness({ fail: () => true });
		h.confirmed.set("tone", "neutral");
		void h.lane.set({ tone: "plain" });
		await h.release();
		expect(h.store.tone).toBe("neutral");
		void h.lane.set({ tone: "formal" });
		await h.release();
		expect(h.store.tone).toBe("neutral");
		expect(h.events).toEqual(["failed:tone", "failed:tone"]);
	});

	it("leaves a failed key alone when a newer value for it is pending, since that value goes out next", async () => {
		const h = harness({ fail: (_body, n) => n === 1 });
		h.confirmed.set("tone", "neutral");
		void h.lane.set({ tone: "plain" });
		void h.lane.set({ tone: "formal" });
		await h.release();
		expect(h.store.tone, "Formal was overwritten by the restore of Plain's failure").toBe("formal");
		expect(h.events).toEqual(["failed:"]);
		await h.release();
		expect(h.events).toEqual(["failed:", "saved:tone"]);
		expect(h.confirmed.get("tone")).toBe("formal");
	});

	it("keeps a queued newer value through the first failure and restores the confirmed value only when that fails too", async () => {
		// Plain is in flight, Formal is queued behind it, and both fail: the row reads Formal after the
		// first failure and Neutral, what the database holds, after the second.
		const h = harness({ fail: () => true });
		h.confirmed.set("tone", "neutral");
		void h.lane.set({ tone: "plain" });
		void h.lane.set({ tone: "formal" });
		await h.release();
		expect(h.store.tone, "the first failure restored over the queued Formal").toBe("formal");
		expect(h.events).toEqual(["failed:"]);
		await h.release();
		expect(h.store.tone).toBe("neutral");
		expect(h.events).toEqual(["failed:", "failed:tone"]);
		expect(h.bodies).toEqual([{ tone: "plain" }, { tone: "formal" }]);
	});

	it("recovers per key: a failed field goes back while a different pending field still goes out", async () => {
		const h = harness({ fail: (_body, n) => n === 1 });
		h.confirmed.set("tone", "neutral");
		void h.lane.set({ tone: "plain" });
		void h.lane.set({ answerLength: "short" });
		await h.release();
		expect(h.store.tone).toBe("neutral");
		expect(h.store.answerLength).toBe("short");
		expect(h.events).toEqual(["failed:tone"]);
		await h.release();
		expect(h.bodies).toEqual([{ tone: "plain" }, { answerLength: "short" }]);
		expect(h.confirmed.get("answerLength")).toBe("short");
		expect(h.confirmed.has("tone")).toBe(true);
		expect(h.confirmed.get("tone")).toBe("neutral");
	});

	it("restores a never-saved key to undefined, the default", async () => {
		const h = harness({ fail: () => true });
		void h.lane.set({ answerLength: "detailed" });
		await h.release();
		expect(h.store.answerLength).toBeUndefined();
	});

	it("reports busy only while a request is in flight", async () => {
		const h = harness();
		expect(h.lane.busy()).toBe(false);
		const done = h.lane.set({ tone: "plain" });
		expect(h.lane.busy()).toBe(true);
		await h.release();
		await done;
		expect(h.lane.busy()).toBe(false);
	});
});
