import { describe, expect, it, vi } from "vitest";
import { refreshProviderEmail, type EmailRefreshAdapter } from "./refreshProviderEmail";

vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const signIn = { action: "sign-in", method: "oauth", oauth: { providerId: "google" } };

const CREATED = new Date("2026-10-01T10:00:00Z");

// Every user here was created by a Google sign-in unless `linkedLater` names it: then Google was
// linked a day after the account was made another way (an email code, another provider).
function adapter(
	users: Record<string, string>,
	opts: { throwOnFind?: boolean; linkedLater?: string[]; linkedAfterMs?: number } = {}
) {
	const updates: Array<[string, { email: string; emailVerified: boolean }]> = [];
	const a: EmailRefreshAdapter = {
		findUserById: async (id) => {
			if (opts.throwOnFind) throw new Error("db down");
			return users[id] ? { id, email: users[id], createdAt: CREATED } : null;
		},
		findAccounts: async (id) => [
			{
				providerId: "google",
				createdAt: opts.linkedLater?.includes(id)
					? new Date(CREATED.getTime() + (opts.linkedAfterMs ?? 86_400_000))
					: new Date(CREATED.getTime() + 40),
			},
		],
		findUserByEmail: async (email) => {
			const id = Object.keys(users).find((k) => users[k] === email);
			return id ? { user: { id, email } } : null;
		},
		updateUser: async (id, data) => {
			updates.push([id, data]);
			users[id] = data.email;
		},
	};
	return { a, updates, users };
}

describe("refreshProviderEmail (CUR-3249)", () => {
	it("takes the provider's new email when it is verified and nobody else holds it", async () => {
		const { a, updates, users } = adapter({ u1: "old@example.org" });
		const out = await refreshProviderEmail(
			{ user: { id: "u1", email: "New@Example.org", emailVerified: true }, source: signIn },
			a
		);
		expect(out).toBe("updated");
		expect(updates).toEqual([["u1", { email: "new@example.org", emailVerified: true }]]);
		expect(users.u1).toBe("new@example.org");
	});

	it("keeps ours when the provider has not verified the new email, so team flags never read an unverified domain", async () => {
		const { a, updates } = adapter({ u1: "old@example.org" });
		const out = await refreshProviderEmail(
			{ user: { id: "u1", email: "someone@currentai.org", emailVerified: false }, source: signIn },
			a
		);
		expect(out).toBe("unverified");
		expect(updates).toEqual([]);
	});

	it("keeps ours, and still lets the sign-in through, when another user holds the new email", async () => {
		const { a, updates } = adapter({ u1: "old@example.org", u2: "taken@example.org" });
		const out = await refreshProviderEmail(
			{ user: { id: "u1", email: "taken@example.org", emailVerified: true }, source: signIn },
			a
		);
		expect(out).toBe("held-by-another");
		expect(updates).toEqual([]);
	});

	it("keeps ours when the provider was linked to an account made another way, so a linked provider never renames it", async () => {
		const { a, updates } = adapter({ u1: "code@example.org" }, { linkedLater: ["u1"] });
		const out = await refreshProviderEmail(
			{ user: { id: "u1", email: "linked@example.org", emailVerified: true }, source: signIn },
			a
		);
		expect(out).toBe("linked-later");
		expect(updates).toEqual([]);
	});

	it("keeps ours when the provider was linked seconds after an email-code sign-up, as a fast test does", async () => {
		const { a, updates } = adapter({ u1: "code@example.org" }, { linkedLater: ["u1"], linkedAfterMs: 10_000 });
		const out = await refreshProviderEmail(
			{ user: { id: "u1", email: "linked@example.org", emailVerified: true }, source: signIn },
			a
		);
		expect(out).toBe("linked-later");
		expect(updates).toEqual([]);
	});

	it("writes nothing when the provider's email matches ours", async () => {
		const { a, updates } = adapter({ u1: "same@example.org" });
		expect(
			await refreshProviderEmail({ user: { id: "u1", email: "same@example.org", emailVerified: true }, source: signIn }, a)
		).toBe("unchanged");
		expect(updates).toEqual([]);
	});

	it("touches nothing outside a returning OAuth sign-in (new users, links, email codes)", async () => {
		const { a, updates } = adapter({ u1: "old@example.org" });
		for (const source of [
			{ action: "create-user", method: "oauth", oauth: { providerId: "google" } },
			{ action: "link-account", method: "oauth", oauth: { providerId: "github" } },
			{ action: "create-user", method: "email-otp" },
		]) {
			expect(
				await refreshProviderEmail({ user: { id: "u1", email: "new@example.org", emailVerified: true }, source }, a)
			).toBe("skipped");
		}
		expect(updates).toEqual([]);
	});

	it("never throws, so a failed lookup costs a stale email rather than refusing the sign-in", async () => {
		const { a, updates } = adapter({ u1: "old@example.org" }, { throwOnFind: true });
		await expect(
			refreshProviderEmail({ user: { id: "u1", email: "new@example.org", emailVerified: true }, source: signIn }, a)
		).resolves.toBe("failed");
		expect(updates).toEqual([]);
	});
});
