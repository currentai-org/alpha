// The real, reviewed Payload page at /privacy-notice is the single source of truth: send every
// visitor straight to it instead of maintaining a second copy in-chat, which would drift into two
// different privacy notices reachable from the same product.
import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { sitePageHref } from "$lib/chat/paths";

export const load: PageServerLoad = () => {
	redirect(301, sitePageHref("/privacy-notice", process.env.VERCEL_ENV));
};
