// The files page at /chat/storage. The load is shared with the settings pane's copy of
// this view; the gate lives there.
import type { PageServerLoad } from "./$types";
import { loadFilesPage } from "$lib/chat/server/storage/filesPageLoad";

export const load: PageServerLoad = (event) => loadFilesPage(event);
