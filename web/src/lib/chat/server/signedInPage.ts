// The opening of every load for a page that shows one person's own data: nothing may cache the
// render, and a signed-out visitor goes to sign-in with a way back to where they were.
import type { RequestEvent } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";

import { base } from "$lib/chat/paths";

type SignedInPageEvent = Pick<RequestEvent, "locals" | "url" | "setHeaders">;

export function requireSignedInPage(event: SignedInPageEvent): NonNullable<App.Locals["user"]> {
	event.setHeaders({ "cache-control": "private, no-store" });
	if (!event.locals.user) {
		const next = event.url.pathname + event.url.search;
		throw redirect(302, `${base}/login?next=${encodeURIComponent(next)}`);
	}
	return event.locals.user;
}
