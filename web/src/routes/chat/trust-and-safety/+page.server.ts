// The real, reviewed Payload page at /trust-and-safety is the single source of truth: send every
// visitor straight to it instead of maintaining a second copy in-chat, which would drift into two
// different Trust & Safety pages reachable from the same product.
import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { sitePageHref } from "$lib/chat/paths";

export const load: PageServerLoad = () => {
	redirect(301, sitePageHref("/trust-and-safety", process.env.VERCEL_ENV));
};
