import { createDemoPageData } from '$lib/alpha-landing/demo-page-data';
import type { LayoutLoad } from './$types';

// The chat components read their payload (greeting, serving line, retention copy, prompt examples,
// feature gates) from `page.data`, where /chat's layout load puts it. The demo builds the same payload
// on sample data, so every component sees /alpha and /alpha/demo the way it sees /chat.
export const load: LayoutLoad = async ({ parent }) => createDemoPageData((await parent()).locale);
