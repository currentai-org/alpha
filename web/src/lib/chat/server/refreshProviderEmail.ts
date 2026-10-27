// A returning OAuth user is found by the provider's own user id, never by email, so the
// address stored at first sign-in stays put after the person changes it at Google, GitHub or Hugging
// Face unless it is refreshed. Team flags would then follow the old domain, mail would go to the old
// inbox, and an email code at the new address would open a second, empty account.
//
// Better Auth's `user.validateUserInfo` is the one seam that sees the provider's fresh email on a
// returning sign-in (action "sign-in"). Its own `overrideUserInfoOnSignIn` was rejected: it also
// rewrites the display name set in Settings (CUR-1176), and it copies an email the provider has not
// verified, which team flags would then read (CUR-3182).
//
// Only the provider that created the account may change its address. An account made by an email
// code, or by another provider, keeps its own address when a provider linked to it later reports a
// different one: that address names the linked provider's account, never this one. "Created it" is
// read from the provider's account row: Better Auth's createOAuthUser writes it in the same
// transaction as the user, milliseconds apart, while a link comes seconds later at the earliest.
//
// The new address is taken only when the provider marks it verified and no other user holds it.
// Anything else keeps the stored email. This runs inside a validator, where a throw refuses the
// sign-in, so it never throws: a failed refresh costs a stale email, never a failed sign-in. (CUR-3249)
import { logger } from "$lib/chat/server/logger";

type ValidateData = {
	user: { id?: string; email?: string; emailVerified?: boolean };
	source: { action: string; method: string; oauth?: { providerId: string } };
};

type StoredUser = { id: string; email: string; createdAt?: Date | string };

const CREATED_TOGETHER_MS = 2_000;

/** The slice of Better Auth's internal adapter this needs, so a test can hand in its own. */
export type EmailRefreshAdapter = {
	findUserById(userId: string): Promise<StoredUser | null>;
	findAccounts(userId: string): Promise<Array<{ providerId: string; createdAt?: Date | string }>>;
	findUserByEmail(email: string): Promise<{ user: StoredUser } | null>;
	updateUser(userId: string, data: { email: string; emailVerified: boolean }): Promise<unknown>;
};

export type EmailRefreshOutcome = "skipped" | "unchanged" | "linked-later" | "unverified" | "held-by-another" | "updated" | "failed";

export async function refreshProviderEmail(data: ValidateData, adapter: EmailRefreshAdapter): Promise<EmailRefreshOutcome> {
	if (data.source.action !== "sign-in" || data.source.method !== "oauth") return "skipped";
	const userId = data.user.id;
	const email = data.user.email?.trim().toLowerCase();
	if (!userId || !email) return "skipped";
	const provider = data.source.oauth?.providerId;
	const started = Date.now();
	try {
		const stored = await adapter.findUserById(userId);
		if (!stored || stored.email === email) return "unchanged";
		const userCreated = new Date(stored.createdAt ?? Number.NaN).getTime();
		const createdIt = (await adapter.findAccounts(userId)).some(
			(acc) =>
				acc.providerId === provider &&
				Math.abs(new Date(acc.createdAt ?? Number.NaN).getTime() - userCreated) <= CREATED_TOGETHER_MS
		);
		if (!createdIt) {
			logger.info({ provider, ms: Date.now() - started }, "[refreshProviderEmail] provider was linked later; kept ours");
			return "linked-later";
		}
		if (data.user.emailVerified !== true) {
			logger.info({ provider, ms: Date.now() - started }, "[refreshProviderEmail] provider email changed but is unverified; kept ours");
			return "unverified";
		}
		const holder = await adapter.findUserByEmail(email);
		if (holder && holder.user.id !== userId) {
			logger.warn({ provider, ms: Date.now() - started }, "[refreshProviderEmail] provider email belongs to another user; kept ours");
			return "held-by-another";
		}
		await adapter.updateUser(userId, { email, emailVerified: true });
		logger.info({ provider, ms: Date.now() - started }, "[refreshProviderEmail] took the provider's new verified email");
		return "updated";
	} catch (err) {
		logger.warn({ err, provider, ms: Date.now() - started }, "[refreshProviderEmail] refresh failed; kept ours");
		return "failed";
	}
}
