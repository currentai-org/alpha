import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/config", () => ({ config: { PUBLIC_ORIGIN: "https://example.test" } }));
vi.mock("$lib/chat/server/db/client", () => ({ getDb: () => ({}) }));

import {
	DEDUPE_WINDOW_MS,
	fanOutReport,
	linearSink,
	linearTitle,
	reportAnchorUrl,
	type FanoutDeps,
	type LinearSink,
} from "./reportFanout";

const ORIGIN = "https://example.test";
const PASTED = "My passport number is X1234567 and I live at 12 Example Road";

function row(id: string, over: Partial<Parameters<typeof fanOutReport>[0]> = {}) {
	return {
		id,
		reason: "inaccurate" as const,
		category: null,
		answerText: "Paris is the capital of Germany.\nIt has been since 1871.",
		answerModel: "swiss-ai/apertus-v1.5-70b",
		userId: "u1",
		sessionId: "s1",
		createdAt: new Date("2026-09-30T12:00:00Z"),
		...over,
	};
}

function fakeLinear(): LinearSink & { calls: string[]; issues: Map<string, string> } {
	const issues = new Map<string, string>();
	const calls: string[] = [];
	return {
		calls,
		issues,
		async createIssue({ title, description, url }) {
			calls.push(`create:${title}|${description}`);
			const id = `issue-${issues.size + 1}`;
			issues.set(url, id);
			return id;
		},
		async findIssueByUrl(url) {
			return issues.get(url) ?? null;
		},
		async comment(issueId, body) {
			calls.push(`comment:${issueId}:${body}`);
		},
	};
}

function deps(over: Partial<FanoutDeps> = {}): FanoutDeps & { slackTexts: string[] } {
	const slackTexts: string[] = [];
	return {
		slackTexts,
		flagOn: () => true,
		origin: () => ORIGIN,
		recentFromReporter: async (r) => [r],
		slack: async (t) => {
			slackTexts.push(t);
		},
		linear: fakeLinear(),
		...over,
	};
}

describe("report fan-out (CUR-997)", () => {
	it("does nothing at all when the report-fanout flag is off", async () => {
		const d = deps({ flagOn: () => false });
		const linear = d.linear as ReturnType<typeof fakeLinear>;
		expect(await fanOutReport(row("r1"), d)).toEqual({ skipped: "flag-off" });
		expect(d.slackTexts).toEqual([]);
		expect(linear.calls).toEqual([]);
	});

	it("warns and sends nothing when the flag is on but no sink is configured", async () => {
		const d = deps({ slack: null, linear: null });
		expect(await fanOutReport(row("r1"), d)).toEqual({ skipped: "unconfigured" });
	});

	it("posts Slack a link and the reason only, and opens one Linear issue titled with the answer's first line", async () => {
		const d = deps();
		const linear = d.linear as ReturnType<typeof fakeLinear>;
		const out = await fanOutReport(row("r1"), d);
		expect(out).toEqual({ slack: true, issue: "issue-1" });
		expect(d.slackTexts).toEqual([
			`New answer report (Inaccurate or misleading): ${ORIGIN}/chat/admin/reports#report-r1`,
		]);
		expect(linear.calls[0]).toMatch(
			/^create:User report: Inaccurate or misleading: Paris is the capital of Germany\.\|/
		);
		expect(linear.issues.get(reportAnchorUrl(ORIGIN, "r1"))).toBe("issue-1");
	});

	it("keeps pasted personal details out of Slack and Linear for a privacy report", async () => {
		const d = deps();
		const linear = d.linear as ReturnType<typeof fakeLinear>;
		await fanOutReport(row("r1", { reason: "privacy", answerText: PASTED }), d);
		const everything = [...d.slackTexts, ...linear.calls].join("\n");
		expect(everything).not.toContain("X1234567");
		expect(everything).not.toContain("Example Road");
		expect(d.slackTexts[0]).toContain(`${ORIGIN}/chat/admin/reports#report-r1`);
		expect(linearTitle(row("r1", { reason: "privacy", answerText: PASTED }))).toBe(
			"User report: Privacy or copyright"
		);
	});

	it("makes four reports from one person in two minutes into one issue with a count and one Slack post", async () => {
		const linear = fakeLinear();
		const filed: ReturnType<typeof row>[] = [];
		const d = deps({
			linear,
			recentFromReporter: async (_r, since) => filed.filter((f) => f.createdAt >= since),
		});
		for (let i = 0; i < 4; i++) {
			const r = row(`r${i + 1}`, { createdAt: new Date(Date.parse("2026-09-30T12:00:00Z") + i * 20_000) });
			filed.push(r);
			await fanOutReport(r, d);
		}
		expect(linear.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
		expect(d.slackTexts).toHaveLength(1);
		const comments = linear.calls.filter((c) => c.startsWith("comment:issue-1:"));
		expect(comments).toHaveLength(3);
		expect(comments.at(-1)).toContain("4 reports from this person, each within 2 minutes of the last");
	});

	// Measuring back one window from each new report would find, for the third of a steady
	// stream, the second (a repeat with no issue of its own), so it would be neither counted nor commented. (CUR-2913)
	it("counts the third report of a 90-second stream on the first report's issue", async () => {
		const linear = fakeLinear();
		const filed: ReturnType<typeof row>[] = [];
		const d = deps({
			linear,
			recentFromReporter: async (_r, since) => filed.filter((f) => f.createdAt >= since),
		});
		const t0 = Date.parse("2026-09-30T12:00:00Z");
		const results = [];
		for (const [i, s] of [0, 90, 180].entries()) {
			const r = row(`s${i + 1}`, { createdAt: new Date(t0 + s * 1000) });
			filed.push(r);
			results.push(await fanOutReport(r, d));
		}
		expect(linear.issues.size).toBe(1);
		const [issue] = [...linear.issues.values()];
		expect(results[2]).toEqual({ counted: 3, issue });
	});

	it("opens a fresh issue once the dedupe window has passed", async () => {
		const linear = fakeLinear();
		const filed: ReturnType<typeof row>[] = [];
		const d = deps({
			linear,
			recentFromReporter: async (_r, since) => filed.filter((f) => f.createdAt >= since),
		});
		const t0 = Date.parse("2026-09-30T12:00:00Z");
		for (const [id, t] of [
			["r1", t0],
			["r2", t0 + DEDUPE_WINDOW_MS + 1_000],
		] as const) {
			const r = row(id, { createdAt: new Date(t) });
			filed.push(r);
			await fanOutReport(r, d);
		}
		expect(linear.calls.filter((c) => c.startsWith("create:"))).toHaveLength(2);
	});

	it("still opens the Linear issue when Slack is down, and never rejects", async () => {
		const d = deps({
			slack: async () => {
				throw new Error("Slack 503");
			},
		});
		const out = await fanOutReport(row("r1"), d);
		expect(out).toEqual({ slack: false, issue: "issue-1" });
	});

	it("resolves (never rejects) when every sink and the dedupe lookup throw", async () => {
		const boom = async () => {
			throw new Error("down");
		};
		const d = deps({
			recentFromReporter: boom,
			slack: boom,
			linear: { createIssue: boom, findIssueByUrl: boom, comment: boom },
		});
		await expect(fanOutReport(row("r1"), d)).resolves.toEqual({ slack: false, issue: null });
	});
});

describe("linearSink", () => {
	it("creates the issue on the configured team and attaches the report link", async () => {
		const bodies: { query: string; variables: Record<string, unknown> }[] = [];
		const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const b = JSON.parse(String(init?.body));
			bodies.push(b);
			const data = b.query.includes("issueCreate")
				? { issueCreate: { issue: { id: "L-1" } } }
				: { attachmentLinkURL: { success: true } };
			return new Response(JSON.stringify({ data }), { status: 200 });
		}) as unknown as typeof fetch;
		const id = await linearSink("key", "team-1", fetchImpl).createIssue({
			title: "t",
			description: "d",
			url: "https://example.test/chat/admin/reports#report-r1",
		});
		expect(id).toBe("L-1");
		expect(bodies[0].variables).toEqual({ input: { teamId: "team-1", title: "t", description: "d" } });
		expect(bodies[1].variables).toEqual({
			issueId: "L-1",
			url: "https://example.test/chat/admin/reports#report-r1",
		});
	});

	it("throws on a GraphQL error so the fan-out logs it as a failed sink", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ errors: [{ message: "bad team" }] }), {
				status: 200,
			})) as unknown as typeof fetch;
		await expect(
			linearSink("key", "team-1", fetchImpl).findIssueByUrl("https://example.test/x")
		).rejects.toThrow("bad team");
	});
});
