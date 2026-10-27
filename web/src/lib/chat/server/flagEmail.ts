/**
 * The email a flag evaluation may see for this person: theirs only once it is verified (CUR-3182).
 *
 * @remarks
 * Team-only release conditions match `email` against the team domains, so the address works as a
 * credential here. Better Auth signs a person in whatever their provider says about the
 * address (genericOAuth reads `email_verified ?? false`), so an unverified one on a team domain
 * would otherwise unlock team features. Every flag call that sends an email takes it from here.
 *
 * Its own module rather than part of flags.ts, so a spec that mocks flags.ts still gets the real
 * verification rule.
 */
export function flagEmail(user: { email?: string; emailVerified?: boolean } | undefined | null): string | undefined {
	return user?.emailVerified === true && user.email ? user.email : undefined;
}
