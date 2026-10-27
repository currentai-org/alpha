export type OrgRow = { id: string; name: string; slug: string; joinMethod: string; configChangeRule: string };

type AuthError = { status?: number; message?: string };
type ListOrgsResult = { data: OrgRow[] | null; error: AuthError | null };

export const SIGNED_OUT_COPY = "You're signed out. Sign in again to manage your workspaces.";

/** A Better Auth call refused for want of a session (CUR-4108). */
export function isSignedOut(error: AuthError | null | undefined): boolean {
	return error?.status === 401;
}

/**
 * What this page says when a Better Auth call fails. A 401 means the session ended under the page,
 * most often in the moment between signing out and the logout's reload, and Better Auth's own text
 * for it is the bare word "Unauthorized" (CUR-3280).
 */
export function pageErrorText(error: AuthError, fallback: string): string {
	if (isSignedOut(error)) return SIGNED_OUT_COPY;
	return error.message ?? fallback;
}

/**
 * The zero-org production case (org creation off) is a categorical route refusal, not a fetch that
 * can genuinely fail for other reasons — so it's resolved without a network attempt at all, never
 * by calling `authClient.organization.list()` and branching on its error. Branching on `error` there would make a
 * refused call look identical to a real failure and render the `orgsError` message instead of the
 * intended zero-org personal-workspace view.
 */
export function resolveOrganizationsState(
	workspaceOrgCreationEnabled: false
): { orgs: OrgRow[]; orgsError: "" };
export function resolveOrganizationsState(
	workspaceOrgCreationEnabled: true,
	listResult: ListOrgsResult
): { orgs: OrgRow[] | null; orgsError: string };
export function resolveOrganizationsState(
	workspaceOrgCreationEnabled: boolean,
	listResult?: ListOrgsResult
): { orgs: OrgRow[] | null; orgsError: string } {
	if (!workspaceOrgCreationEnabled) {
		return { orgs: [], orgsError: "" };
	}
	if (!listResult) {
		throw new Error("resolveOrganizationsState: listResult is required when org creation is enabled");
	}
	if (listResult.error) {
		return { orgs: null, orgsError: pageErrorText(listResult.error, "Couldn't load your workspaces.") };
	}
	return { orgs: listResult.data ?? [], orgsError: "" };
}
