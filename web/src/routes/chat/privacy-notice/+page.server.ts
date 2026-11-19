// The real, reviewed Payload page at /privacy-notice is the single source of truth: send every
// visitor straight to it instead of maintaining a second copy in-chat, which would drift into two
// different privacy notices reachable from the same product.
import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { sitePageHref } from "$lib/chat/paths";
import { deployEnvName } from "$lib/server/runtimeEnv";

export const load: PageServerLoad = () => {
	const href = sitePageHref("/privacy-notice", deployEnvName());
	if (!href) error(404, "Not found");
	redirect(301, href);
};
