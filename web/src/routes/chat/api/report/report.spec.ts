/**
 * the general "Report a problem" route runs the shared per-session limiter before it saves,
 * so one visitor cannot fill the reports queue. The real route and limiter run; the limiter's event
 * window is an in-memory stand-in for the database and `saveReport` is a spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as { type: string; userId?: unknown; expiresAt: number }[]);
vi.mock("$lib/chat/server/db/eventWindow", () => ({
	countLiveEvents: async (key: { type: string; userId?: unknown }) =>
		events.filter(
			(e) =>
				e.type === key.type &&
				(key.userId === undefined || String(e.userId) === String(key.userId)) &&
				e.expiresAt > Date.now()
		).length,
	secondsUntilRoom: async () => 1,
	recordEvent: async (key: { type: string; userId?: unknown }, windowMs: number) => {
		events.push({ ...key, expiresAt: Date.now() + windowMs });
	},
	recordEvents: async () => {},
}));
vi.mock("$lib/chat/server/usageLimits", () => ({ usageLimits: { messagesPerMinute: 3 } }));
vi.mock("$lib/chat/server/alerting", () => ({ recordRateLimitTrip: async () => {} }));
const saveReport = vi.hoisted(() => vi.fn(async () => ({ id: "r1" })));
vi.mock("$lib/chat/server/db/reports", () => ({ saveReport }));

import { POST } from "./+server";

async function report(sessionId: string): Promise<number> {
	try {
		const res = await POST({
			request: new Request("http://localhost/chat/api/report", {
				method: "POST",
				body: JSON.stringify({ category: "bug", detail: "it broke" }),
			}),
			locals: { sessionId },
			getClientAddress: () => "203.0.113.9",
		} as never);
		return res.status;
	} catch (e) {
		return (e as { status?: number }).status ?? 500;
	}
}

describe("general report route rate limit", () => {
	beforeEach(() => {
		events.length = 0;
		saveReport.mockClear();
	});

	it("answers 429 past the per-session limit and saves no row for the refused request", async () => {
		for (let i = 0; i < 3; i++) expect(await report("session-a")).toBe(200);
		expect(saveReport).toHaveBeenCalledTimes(3);
		expect(await report("session-a")).toBe(429);
		expect(saveReport).toHaveBeenCalledTimes(3);
	});

	it("keeps another session's budget separate", async () => {
		for (let i = 0; i < 4; i++) await report("session-a");
		expect(await report("session-b")).toBe(200);
	});
});
