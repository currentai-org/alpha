// Once a PR merges, a daily job deletes its `pr-<N>` database branch, but the PR's preview stays
// reachable. A page load then finds the CMS answering 500 (the CMS preview shared that branch) and
// Postgres refusing the old credentials (28P01), which would otherwise surface as a bare
// "Internal Error". This names the case instead.
//
// Only the error MESSAGE changes, and only on a PR preview. client.ts and cached-client.ts stay
// fail-loud: on production and develop a Payload 500 is a real failure and must read as one.

const EXPIRED_PREVIEW_MESSAGE =
	"This preview's data is gone. Its pull request was most likely merged or closed, which removes the preview's database. Open develop.aipotluck.org, or the latest preview of an open pull request.";

type PreviewEnv = { VERCEL_ENV?: string; VERCEL_GIT_COMMIT_REF?: string };

/** A per-PR preview: not production, and not develop's long-lived preview, whose database is never reaped. */
function isPullRequestPreview(env: PreviewEnv): boolean {
	return env.VERCEL_ENV === 'preview' && env.VERCEL_GIT_COMMIT_REF !== 'develop';
}

/**
 * Does this error look like a reaped preview database? A Payload fetch answered 5xx, or Postgres
 * rejected the password (SQLSTATE 28P01). Walks `cause`, since a load function may wrap either.
 */
function looksLikeReapedDatabase(error: unknown): boolean {
	for (let e = error, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
		const { name, status, code } = e as { name?: unknown; status?: unknown; code?: unknown };
		if (name === 'PayloadFetchError' && typeof status === 'number' && status >= 500) return true;
		if (code === '28P01') return true;
		e = (e as { cause?: unknown }).cause;
	}
	return false;
}

/** The message to show instead of "Internal Error", or undefined to leave the error as it is. */
export function expiredPreviewMessage(error: unknown, env: PreviewEnv): string | undefined {
	return isPullRequestPreview(env) && looksLikeReapedDatabase(error)
		? EXPIRED_PREVIEW_MESSAGE
		: undefined;
}
