import { devToolsOnlyLoad } from "$lib/chat/settingsSections";

// Developer-only (the local dev server, or an admin), the same gate as its nav entry: the routing lab
// still carries a PLACEHOLDER badge (CUR-3252), so a visitor on prod who has the URL anyway lands on
// Settings rather than the lab.
export const load = devToolsOnlyLoad;
