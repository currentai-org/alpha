/**
 * A visitor's own reports page. Two contracts. Each visitor sees only the reports they sent:
 * a guest by session, never a row that carries a user id, and a signed-in user by user id. And the
 * status a reporter reads is the one staff set on the admin page, which only an admin can set. (CUR-3903)
 */
import { afterEach, describe, expect, it } from "vitest";
import { listOwnReports, saveReport } from "$lib/chat/server/db/reports";
import { cleanupTestData, createTestLocals } from "$lib/chat/server/api/__tests__/testHelpers";
import { actions } from "../../../../../routes/chat/admin/reports/+page.server";

async function setStatusAs(locals: App.Locals, id: string, status: string) {
	const fd = new FormData();
	fd.set("id", id);
	fd.set("status", status);
	const request = new Request("http://localhost/chat/admin/reports?/setStatus", { method: "POST", body: fd });
	return actions.setStatus({ request, locals, cookies: { get: () => undefined } } as never);
}

/** A signed-in person holding the admin role, the only role that reads reports (CUR-3992). */
function adminLocals(): App.Locals {
	return createTestLocals({ user: { role: "admin" } as App.Locals["user"] });
}

describe.sequential("own reports (CUR-3903)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("a guest sees only their own session's reports, never another session's or a signed-in row on the same session", async () => {
		await saveReport({ sessionId: "guest-a", category: "bug", detail: "mine" });
		await saveReport({ sessionId: "guest-b", category: "ux", detail: "someone else's" });
		// Same session after signing in: filed under the account, so the guest view must not show it.
		await saveReport({ sessionId: "guest-a", userId: "user-1", category: "other", detail: "account's" });

		const rows = await listOwnReports({ sessionId: "guest-a" });
		expect(rows.map((r) => r.detail)).toEqual(["mine"]);
	});

	it("a signed-in user sees only the rows carrying their user id, whatever session filed them", async () => {
		await saveReport({ sessionId: "s1", userId: "user-1", category: "bug", detail: "first" });
		await saveReport({ sessionId: "s2", userId: "user-1", category: "ux", detail: "second" });
		await saveReport({ sessionId: "s1", userId: "user-2", category: "bug", detail: "not theirs" });
		await saveReport({ sessionId: "s1", category: "bug", detail: "guest row" });

		const rows = await listOwnReports({ userId: "user-1" });
		expect(rows.map((r) => r.detail).sort()).toEqual(["first", "second"]);
	});

	it("a new report reads as received until staff set something else", async () => {
		await saveReport({ sessionId: "guest-a", category: "bug" });
		const [row] = await listOwnReports({ sessionId: "guest-a" });
		expect(row.status).toBe("received");
		expect(row.statusUpdatedAt).toBeNull();
	});

	it("the status an admin sets is the status the reporter reads", async () => {
		const saved = await saveReport({ sessionId: "guest-a", category: "bug" });
		const result = await setStatusAs(adminLocals(), saved.id, "addressed");
		expect(result).toEqual({ statusSet: saved.id });

		const [row] = await listOwnReports({ sessionId: "guest-a" });
		expect(row.status).toBe("addressed");
		expect(row.statusUpdatedAt).toBeInstanceOf(Date);
	});

	it("a visitor who is not an admin cannot set a status, and the report stays received", async () => {
		const saved = await saveReport({ sessionId: "guest-a", category: "bug" });
		await expect(setStatusAs(createTestLocals({ isAdmin: false }), saved.id, "addressed")).rejects.toMatchObject({
			status: expect.any(Number),
		});

		const [row] = await listOwnReports({ sessionId: "guest-a" });
		expect(row.status).toBe("received");
	});

	it("refuses a status that is not one of the five, and leaves the report alone", async () => {
		const saved = await saveReport({ sessionId: "guest-a", category: "bug" });
		const result = await setStatusAs(adminLocals(), saved.id, "deleted");
		expect(result).toMatchObject({ status: 400 });

		const [row] = await listOwnReports({ sessionId: "guest-a" });
		expect(row.status).toBe("received");
	});
});
