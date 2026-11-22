import { unlocalizedPath } from '$lib/i18n/routing';
import { chatRoutePath } from '$lib/surface';
import type { Reroute, Transport, Transporter } from '@sveltejs/kit';

// Chat ships a custom PublicConfig instance across the SSR boundary. Its transporter is loaded through
// `import.meta.glob`, which is an empty object when chat's files are absent, so the site builds from a
// tree without chat; config/product-boundary.mjs lists it under SEAM_LOADS_OF_CHAT.
const publicConfig = Object.values(
	import.meta.glob<{ publicConfigTransporter: Transporter }>(
		'/src/lib/chat/utils/PublicConfig.svelte.ts',
		{ eager: true }
	)
)[0];

export const transport: Transport = publicConfig
	? { PublicConfig: publicConfig.publicConfigTransporter }
	: {};

// Routing keeps the visible localized URL while resolving the existing page tree. On the chat surface
// it also maps `/x` onto chat's `/chat/x` route; runs in the browser and on the server
// alike, so client navigation resolves the same route the server does. A no-op mapping on the site.
export const reroute: Reroute = ({ url }) => chatRoutePath(unlocalizedPath(url.pathname));
