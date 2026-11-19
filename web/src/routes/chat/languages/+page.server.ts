import type { PageServerLoad } from "./$types";
import { LAUNCH_LANGUAGES } from "$lib/chat/languageData";
import { openingLanguage } from "$lib/chat/routing/leaderboard";

// The public language leaderboard, served by chat because every number and component on it
// is chat's. It opens on the visitor's own language when it is one we test. The site's old address,
// /alpha/languages, redirects here. `ownsHeadTags` tells the chat layout this page writes its own
// title, description and canonical link.
export const load: PageServerLoad = ({ request, url }) => ({
	openingLanguage: openingLanguage(request.headers.get("accept-language"), LAUNCH_LANGUAGES),
	canonicalUrl: `${url.origin}${url.pathname}`,
	ownsHeadTags: true
});
