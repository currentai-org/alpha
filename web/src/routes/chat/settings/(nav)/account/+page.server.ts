/**
 * Which social providers are configured, so the Account section only offers a "Link"
 * button for a provider that's actually reachable. Same computation as login/+page.server.ts
 * (Google/GitHub are each independently optional via betterAuth.ts; Hugging Face is always
 * configured) — kept in this file rather than shared, since the two loads differ in every other
 * respect (login redirects a signed-in visitor away; this route is signed-in-only content) (CUR-580).
 *
 * Signed-in-only is enforced here, on the server. The client-side requireAuthUser() in +page.svelte
 * gates on `automaticLogin` (site-wide FORCED sign-in) and does nothing when login is merely offered,
 * not mandatory, so a signed-out visitor would get "Unauthorized"-shaped error panels instead of a
 * redirect. This mirrors login/+page.server.ts's own event.locals.user check, inverted, and runs
 * before any account data is read.
 */
import type { PageServerLoad } from "./$types";
import { config } from "$lib/chat/server/config";
import { dataExportEnabled, nextExportAt, thunderboltExportEnabled } from "$lib/chat/server/dataPortability";
import { requireSignedInPage } from "$lib/chat/server/signedInPage";
import { getAuth } from "$lib/chat/server/betterAuth";

/** One Better Auth call's outcome: its value, or the error code it failed with (null if none). */
type Settled<T> = { ok: true; value: T } | { ok: false; code: string | null };

async function settle<T>(call: () => Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await call() };
	} catch (e) {
		const code = (e as { body?: { code?: unknown } })?.body?.code;
		return { ok: false, code: typeof code === "string" ? code : null };
	}
}

export const load: PageServerLoad = async (event) => {
	const user = requireSignedInPage(event);

	// Read here, so the HTML arrives with the content in it instead of a skeleton while four
	// browser calls run after hydration (CUR-2710). A call that fails here comes back as
	// `ok: false`, and the page fetches that section from the browser instead.
	const headers = event.request.headers;
	const api = getAuth().api;
	const [accounts, passkeys, sessions, session, next, nextThunderbolt] = await Promise.all([
		settle(() => api.listUserAccounts({ headers })),
		settle(() => api.listPasskeys({ headers })),
		settle(() => api.listSessions({ headers })),
		settle(() => api.getSession({ headers })),
		// The export row says when the next export is possible instead of linking to the route's bare
		// 429 page (one export an hour). Only read when export is on for this deployment.
		dataExportEnabled() ? nextExportAt(user._id) : Promise.resolve(null),
		// The same for the Thunderbolt file (CUR-2407), whose own window is ten minutes.
		thunderboltExportEnabled()
			? nextExportAt(user._id, new Date(), "export-thunderbolt")
			: Promise.resolve(null),
	]);

	return {
		providers: {
			google: !!config.GOOGLE_CLIENT_ID,
			github: !!config.GITHUB_CLIENT_ID,
		},
		nextExportAt: next ? next.toISOString() : null,
		nextThunderboltExportAt: nextThunderbolt ? nextThunderbolt.toISOString() : null,
		initial: { accounts, passkeys, sessions, session },
	};
};
