import { writable } from "svelte/store";

// The page's post-turn message resync re-mints message ids from the server snapshot,
// destroying and re-creating the ReportButton whose local `open`/`busy`/`done` state the user may
// be watching. Ref-counted (not a boolean) since more than one report control could in principle
// be mid-submission at once. ReportButton increments on submit and decrements once its
// acknowledgement (or failure) is no longer something a remount could silently discard; the
// conversation page's resync guard reads this to veto the swap while it's nonzero. (CUR-1583)
export const reportActionHoldCount = writable(0);
