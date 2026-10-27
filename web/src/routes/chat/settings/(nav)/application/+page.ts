import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import type { PageLoad } from "./$types";

// Redirect for the retired General section: old links and bookmarks land on the first section
// instead of a 404.
export const load: PageLoad = () => {
	redirect(308, `${base}/settings/personalization`);
};
