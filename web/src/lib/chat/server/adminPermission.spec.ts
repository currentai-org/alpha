import { describe, it, expect } from "vitest";
import type { Cookies } from "@sveltejs/kit";

import { requireAdminPermission, isAdminPermitted } from "./adminAuth";

function cookieJar(): Cookies {
	const jar = new Map<string, string>();
	return {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
		serialize: () => "",
	} as unknown as Cookies;
}

function locals(user?: { role?: string }, isAdmin = false): App.Locals {
	return {
		sessionId: "s",
		isAdmin,
		user: user ? ({ _id: "u", name: "n", avatarUrl: undefined, ...user } as never) : undefined,
	} as App.Locals;
}

async function status(p: Promise<unknown>): Promise<number | "pass"> {
	try {
		await p;
		return "pass";
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe("requireAdminPermission (CUR-3990, CUR-3992)", () => {
	it("passes a signed-in person whose role holds the permission", async () => {
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals({ role: "editor" }) }, { tuning: "save" }))).toBe("pass");
	});

	it("403s a signed-in person whose role lacks the permission", async () => {
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals({ role: "operator" }) }, { tuning: "save" }))).toBe(403);
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals({ role: "editor" }) }, { reports: "read" }))).toBe(403);
	});

	it("403s a signed-in person with no role at all", async () => {
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals({}) }, { console: "view" }))).toBe(403);
	});

	it("401s a signed-out request", async () => {
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals() }, { console: "view" }))).toBe(401);
	});

	it("401s a signed-out browser still holding a shared-password admin cookie from before CUR-3992", async () => {
		const cookies = cookieJar();
		cookies.set("admin", `ops.${Date.now() + 60_000}.${"a".repeat(64)}`, { path: "/" });
		expect(await status(requireAdminPermission({ cookies, locals: locals() }, { reports: "read" }))).toBe(401);
	});

	it("401s a session carrying only the legacy isAdmin flag: a role is the one way in", async () => {
		expect(await status(requireAdminPermission({ cookies: cookieJar(), locals: locals(undefined, true) }, { console: "view" }))).toBe(401);
	});

	it("isAdminPermitted shows the panel to a role holder and not to a role without the grant", async () => {
		expect(await isAdminPermitted({ cookies: cookieJar(), locals: locals({ role: "operator" }) }, { console: "view" })).toBe(true);
		expect(await isAdminPermitted({ cookies: cookieJar(), locals: locals({ role: "operator" }) }, { reports: "read" })).toBe(false);
	});
});
