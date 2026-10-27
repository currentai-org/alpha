import { devToolsOnlyLoad } from "$lib/chat/settingsSections";

// Developer-only (the local dev server, or an admin), the same gate as its nav entry: a visitor who
// has the URL anyway lands on Settings rather than a page the nav never shows them.
export const load = devToolsOnlyLoad;
