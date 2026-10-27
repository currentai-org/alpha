import { redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { base } from "$lib/chat/paths";
import type { PageLoad } from "./$types";

// Bare /settings has nothing of its own to show (the model list is in the top-bar dropdown), so it
// lands on Personalization, the first section. Redirecting here, in load, resolves the navigation
// before anything renders; a redirect from an $effect after bare /settings renders leaves the dialog
// open on an empty body for a couple of seconds while the second navigation loads. The group renders
// on the server, so a fresh open gets a plain 307 rather than a shell that redirects once the bundle
// loads.
//
// The one exception is `?sections`: at phone width there is no sidebar, so the section list is its
// own page, and each section's back button links here with it. Desktop never links to it.
//
// The account menu's Settings link is a client-side navigation, so this load runs in the browser and
// can see the width. A phone goes to the section list, the first screen iOS and Claude's app show;
// landing it on the first section leaves the rest one tap behind a back button nobody reads as the
// list (CUR-3601). A server render can't know the width and goes to Personalization.
export const load: PageLoad = ({ url }) => {
	if (url.searchParams.has("sections")) return;
	if (browser && !window.matchMedia("(min-width: 768px)").matches) {
		redirect(307, `${base}/settings?sections`);
	}
	redirect(307, `${base}/settings/personalization`);
};
