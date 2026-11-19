// The settings nav's Storage entry opens inside the settings pane, so the person keeps their way
// back. It holds the storage settings, and the chat rail's Files entry opens the files
// at /chat/storage; both share one load and one gate.
import type { PageServerLoad } from "./$types";
import { loadFilesPage } from "$lib/chat/server/storage/filesPageLoad";


export const load: PageServerLoad = (event) => loadFilesPage(event);
