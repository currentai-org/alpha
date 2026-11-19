// The real, reviewed Payload page at /trust-and-safety is the single source of truth: send every
// visitor straight to it instead of maintaining a second copy in-chat, which would drift into two
// different Trust & Safety pages reachable from the same product.
import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { sitePageHref } from "$lib/chat/paths";
import { deployEnvName } from "$lib/server/runtimeEnv";

export const load: PageServerLoad = () => {
	const href = sitePageHref("/trust-and-safety", deployEnvName());
	if (!href) error(404, "Not found");
	redirect(301, href);
};
