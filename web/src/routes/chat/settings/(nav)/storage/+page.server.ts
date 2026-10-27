// The settings nav's Storage entry opens inside the settings pane, so the person keeps their way
// back (CUR-1769). It holds the storage settings, and the chat rail's Files entry opens the files
// at /chat/storage (CUR-4363); both share one load and one gate.
import type { PageServerLoad } from "./$types";
import { loadFilesPage } from "$lib/chat/server/storage/filesPageLoad";


export const load: PageServerLoad = (event) => loadFilesPage(event);
