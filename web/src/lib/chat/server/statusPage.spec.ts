import { describe, expect, it, vi } from "vitest";
import { statusPageState } from "./statusPage";

// The held answer is module state, so each read below happens at least a minute after the one before
// it and asks Better Stack afresh.
const body = (aggregate_state: unknown) =>
	new Response(JSON.stringify({ data: { attributes: { aggregate_state } } }), { status: 200 });
let clock = 0;
const later = () => (clock += 10 * 60_000);

describe("statusPageState (CUR-4062)", () => {
	it("reports the status page's own aggregate state", async () => {
		const f = vi.fn(async () => body("degraded"));
		expect(await statusPageState(f as unknown as typeof fetch, later())).toBe("degraded");
	});

	it("reads an unreadable page as unknown (null), so no banner shows, on a 5xx, a throw or an unknown state", async () => {
		const down = (async () => new Response("x", { status: 503 })) as typeof fetch;
		expect(await statusPageState(down, later())).toBeNull();
		const throws = (async () => {
			throw new Error("timeout");
		}) as typeof fetch;
		expect(await statusPageState(throws, later())).toBeNull();
		expect(await statusPageState((async () => body("on_fire")) as typeof fetch, later())).toBeNull();
	});

	it("asks Better Stack at most once a minute, a failed read included, and again after the minute", async () => {
		const start = later();
		const f = vi.fn(async () => new Response("x", { status: 503 }));
		await statusPageState(f as unknown as typeof fetch, start);
		await statusPageState(f as unknown as typeof fetch, start + 59_999);
		expect(f).toHaveBeenCalledTimes(1);
		f.mockImplementation(async () => body("operational"));
		expect(await statusPageState(f as unknown as typeof fetch, start + 60_000)).toBe("operational");
		expect(f).toHaveBeenCalledTimes(2);
	});
});
