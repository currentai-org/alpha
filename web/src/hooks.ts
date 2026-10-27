import { publicConfigTransporter } from '$lib/chat/utils/PublicConfig.svelte';
import { unlocalizedPath } from '$lib/i18n/routing';
import { chatRoutePath } from '$lib/surface';
import type { Reroute, Transport } from '@sveltejs/kit';

// Chat ships a custom PublicConfig instance across the SSR boundary.
export const transport: Transport = {
	PublicConfig: publicConfigTransporter
};

// Routing keeps the visible localized URL while resolving the existing page tree. On the chat surface
// (CUR-4448) it also maps `/x` onto chat's `/chat/x` route; runs in the browser and on the server
// alike, so client navigation resolves the same route the server does. A no-op mapping on the site.
export const reroute: Reroute = ({ url }) => chatRoutePath(unlocalizedPath(url.pathname));
