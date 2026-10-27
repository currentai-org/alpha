/**
 * Two OAuth sign-ins that happen to share an email never silently merge, even when both assert a
 * verified email, because the person may have deliberately kept them separate (CUR-850). The explicit
 * "Settings → Account → Linked providers → Link" flow (CUR-580) is the only path two accounts can
 * merge through. This file tests that a same-email sign-in collision is refused, not merged, and that
 * the explicit link path still works.
 *
 * Tested directly against Better Auth's own linking decision (handleOAuthUserInfo, the public
 * `better-auth/oauth2` export) rather than through a live OAuth round-trip: no real Google/GitHub/HF app
 * credentials exist in this environment, and the merge decision itself lives entirely in this one
 * function. PKCE/state/token-exchange are transport concerns handled BEFORE it's ever called — not what
 * this invariant is actually about.
 *
 * Real Postgres, no mocks of the linking logic itself, so a wrong key or a wrong emailVerified
 * assumption shows up as two rows (or a wrongly-refused link) instead of the intended shape, not as a
 * green test that asserted the wrong thing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";

function buildTestAuth() {
	return betterAuth({
		database: drizzleAdapter(getDb(), { provider: "pg", schema, usePlural: false }),
		// Never used to sign anything real — this instance only ever calls handleOAuthUserInfo
		// directly, never auth.handler(), so no cookie/session ever leaves this process.
		secret: "test-only-secret-never-used-outside-this-spec-file-32ch",
		// Mirrors betterAuth.ts's real config exactly — this file's whole point is testing the actual
		// configured decision, not Better Auth's un-configured default.
		account: {
			accountLinking: {
				enabled: true,
				disableImplicitLinking: true,
				allowDifferentEmails: true,
			},
		},
	});
}

/** handleOAuthUserInfo's declared param type is the full GenericEndpointContext (method/path/body/
 *  query/…) — but reading its actual source, it only ever touches `c.context`, never any request-shape
 *  field. The cast is scoped to that verified gap, not a blanket escape hatch. */
async function buildContext(): Promise<Parameters<typeof handleOAuthUserInfo>[0]> {
	const context = await buildTestAuth().$context;
	return { context } as unknown as Parameters<typeof handleOAuthUserInfo>[0];
}

async function cleanupByEmail(email: string) {
	const db = getDb();
	const rows = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
	for (const row of rows) {
		await db.delete(schema.account).where(eq(schema.account.userId, row.id));
		await db.delete(schema.session).where(eq(schema.session.userId, row.id));
		await db.delete(schema.user).where(eq(schema.user.id, row.id));
	}
}

describe.sequential("Better Auth account-merge invariant (CUR-850, reverses CUR-482)", () => {
	const emails: string[] = [];

	afterEach(async () => {
		while (emails.length) await cleanupByEmail(emails.pop()!);
	});

	it("a SIGN-IN via a second provider on the same verified email is REFUSED, not merged — even though both providers assert emailVerified", async () => {
		const email = `merge-${newId()}@example.org`;
		emails.push(email);
		const c = await buildContext();

		const first = await handleOAuthUserInfo(c, {
			userInfo: { id: "google-sub-1", email, emailVerified: true, name: "Ada Lovelace" },
			account: {
				providerId: "google",
				accountId: "google-sub-1",
				accessToken: "fake-google-token",
			},
			callbackURL: "/",
		});
		expect(first.error).toBeNull();
		expect(first.isRegister).toBe(true);
		const userId = first.data?.user.id;
		expect(userId).toBeTruthy();

		// Same person, in reality — but this call simulates a FRESH SIGN-IN attempt via Hugging Face,
		// not the authenticated "link a provider" action from Settings. It must not silently merge into the
		// Google account (isRegister: false) (CUR-850): the person has to sign in with Google first, then
		// link Hugging Face explicitly.
		const second = await handleOAuthUserInfo(c, {
			userInfo: { id: "hf-sub-1", email, emailVerified: true, name: "Ada Lovelace" },
			account: {
				providerId: "huggingface",
				accountId: "hf-sub-1",
				accessToken: "fake-hf-token",
			},
			callbackURL: "/",
		});
		expect(second.error).toBe("account not linked");

		const db = getDb();
		// Still exactly one user — the refused sign-in didn't spawn a second account on the same email.
		const users = await db.select().from(schema.user).where(eq(schema.user.email, email));
		expect(users).toHaveLength(1);

		// Still only the original Google account — the Hugging Face attempt left no trace, same as an
		// unverified-email refusal would.
		const accounts = await db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, userId as string));
		expect(accounts.map((a) => a.providerId)).toEqual(["google"]);
	});

	it("explicit link (Settings → Account → Link) then a fresh sign-in via the SECOND provider resolves to the SAME user — the one path CUR-850 keeps open", async () => {
		const email = `merge-${newId()}@example.org`;
		emails.push(email);
		const c = await buildContext();
		// Unique per run — a hardcoded accountId would collide with a leftover row from a prior
		// (possibly failed) run, since account identity is keyed on (providerId, accountId), not email.
		const googleAccountId = `google-sub-${newId()}`;
		const hfAccountId = `hf-sub-${newId()}`;

		// Step 1: sign up via the first provider — the account this session already belongs to.
		const signUp = await handleOAuthUserInfo(c, {
			userInfo: { id: googleAccountId, email, emailVerified: true, name: "Ada Lovelace" },
			account: {
				providerId: "google",
				accountId: googleAccountId,
				accessToken: "fake-google-token",
			},
			callbackURL: "/",
		});
		expect(signUp.error).toBeNull();
		const userId = signUp.data?.user.id as string;
		expect(userId).toBeTruthy();

		// Step 2: the EXPLICIT link action (Settings → Account → Link → authClient.linkSocial), modeled
		// with `selectedUser` — the one parameter that bypasses disableImplicitLinking entirely (line
		// 83's check is `!opts.selectedUser && (...)`), because this call is authenticated as userId
		// already and isn't deciding whether two strangers' sign-ins should merge. A different email on
		// purpose, and this path (handleOAuthUserInfo) never checks it either way, with or without
		// allowDifferentEmails. The separate email-match check (CUR-1768) lives in callback.mjs:175, the
		// redirect-completion handler Hugging Face's genericOAuth plugin runs, which real traffic hits and
		// this synthetic call bypasses.
		const link = await handleOAuthUserInfo(c, {
			userInfo: {
				id: hfAccountId,
				email: `hf-${newId()}@example.org`,
				emailVerified: true,
				name: "Ada Lovelace",
			},
			account: {
				providerId: "huggingface",
				accountId: hfAccountId,
				accessToken: "fake-hf-token",
			},
			callbackURL: "/",
			selectedUser: { userId, profile: "preserve" },
		});
		expect(link.error).toBeNull();
		expect(link.data?.user.id).toBe(userId);

		const db = getDb();
		const linkedAccounts = await db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.where(eq(schema.account.userId, userId));
		expect(linkedAccounts.map((a) => a.providerId).sort()).toEqual(["google", "huggingface"]);

		// Step 3: THE ACTUAL QUESTION THIS TICKET ASKS. Not "did linking write a row" (step 2 already
		// shows that) but "does signing in via the newly-linked provider, on its own, resolve to the
		// SAME account" — a brand-new, unauthenticated sign-in attempt through Hugging Face, no
		// selectedUser this time, exactly like a returning visitor who has never used Google on this
		// device. findAccountOwnerByKey now finds this accountId already owned, so it skips the whole
		// linking decision (and the disableImplicitLinking refusal) and issues a session straight away.
		const signInViaSecondProvider = await handleOAuthUserInfo(c, {
			userInfo: {
				id: hfAccountId,
				email: `hf-${newId()}@example.org`,
				emailVerified: true,
				name: "Ada Lovelace",
			},
			account: {
				providerId: "huggingface",
				accountId: hfAccountId,
				accessToken: "fake-hf-token-2",
			},
			callbackURL: "/",
		});
		expect(signInViaSecondProvider.error).toBeNull();
		expect(signInViaSecondProvider.data?.user.id).toBe(userId);
		expect(signInViaSecondProvider.data?.session.userId).toBe(userId);

		// Still exactly one user row — the linked provider's sign-in didn't fork a second identity.
		const users = await db.select().from(schema.user).where(eq(schema.user.id, userId));
		expect(users).toHaveLength(1);
	});

	it("an UNVERIFIED email from a second provider is ALSO refused — belt and suspenders on top of disableImplicitLinking", async () => {
		const email = `merge-${newId()}@example.org`;
		emails.push(email);
		const c = await buildContext();

		await handleOAuthUserInfo(c, {
			userInfo: { id: "google-sub-2", email, emailVerified: true, name: "Ada" },
			account: { providerId: "google", accountId: "google-sub-2" },
			callbackURL: "/",
		});

		const blocked = await handleOAuthUserInfo(c, {
			userInfo: { id: "shady-sub-1", email, emailVerified: false, name: "Someone Else" },
			account: { providerId: "shady-provider", accountId: "shady-sub-1" },
			callbackURL: "/",
		});
		expect(blocked.error).toBe("account not linked");

		const db = getDb();
		const accounts = await db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.innerJoin(schema.user, eq(schema.account.userId, schema.user.id))
			.where(eq(schema.user.email, email));
		// Only the original google account — the unverified shady-provider attempt left no trace.
		expect(accounts.map((a) => a.providerId)).toEqual(["google"]);
	});
});
