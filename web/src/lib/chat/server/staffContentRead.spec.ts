// A staff read of conversation content is recorded in the security dataset and in
// admin_audit, with its reason, and never with the content itself. (CUR-4385)
import { describe, it, expect, vi, beforeEach } from "vitest";

const securityInfo = vi.fn();
const logAdminActionSafe = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ securityLogger: { info: securityInfo } }));
vi.mock("$lib/chat/server/db/adminAudit", () => ({ logAdminActionSafe }));
vi.mock("$lib/chat/server/db/ipHash", () => ({ hashIp: (ip: string | null) => (ip ? `hash(${ip})` : null) }));

const { acceptableReason, recordStaffContentRead } = await import("./staffContentRead");

describe("staff content reads (CUR-4385)", () => {
	beforeEach(() => {
		securityInfo.mockReset();
		logAdminActionSafe.mockReset();
	});

	it("records actor, conversations and reason to the security dataset and to admin_audit, with the IP hashed", () => {
		recordStaffContentRead({
			actor: "staff@example.org",
			surface: "report.view",
			conversationIds: ["c1"],
			reason: "report r1",
			ip: "203.0.113.9",
		});
		expect(securityInfo).toHaveBeenCalledTimes(1);
		const [fields] = securityInfo.mock.calls[0];
		expect(fields).toMatchObject({
			event: "staff.conversation_read",
			actor: "staff@example.org",
			surface: "report.view",
			conversationIds: ["c1"],
			reason: "report r1",
			ipHash: "hash(203.0.113.9)",
		});
		expect(JSON.stringify(fields)).not.toContain("203.0.113.9\"");
		expect(logAdminActionSafe).toHaveBeenCalledWith(
			expect.objectContaining({ actor: "staff@example.org", action: "report.view", target: "c1", summary: "reason: report r1" })
		);
	});

	it("still writes the admin_audit row when the security logger throws, so one sink failing never drops both", () => {
		securityInfo.mockImplementation(() => {
			throw new Error("stream closed");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			recordStaffContentRead({ actor: "a", surface: "reports.list", conversationIds: ["c1", "c2"], reason: "reports triage queue" })
		).not.toThrow();
		expect(logAdminActionSafe).toHaveBeenCalledWith(expect.objectContaining({ target: "2 conversations" }));
	});

	it("treats a missing or too-short typed reason as no reason, so content stays hidden", () => {
		expect(acceptableReason(null)).toBeNull();
		expect(acceptableReason("  why  ")).toBeNull();
		expect(acceptableReason("CUR-12:  user   asked")).toBe("CUR-12: user asked");
		expect(acceptableReason("x".repeat(900))?.length).toBe(500);
	});
});
