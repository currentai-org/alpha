// Markers the URL guard ($lib/chat/server/urlGuard) uses to flag an unverifiable URL, and that the markdown
// renderer ($lib/chat/utils/marked) recognises. Live here (client+server safe) so writer and renderer can't drift.

// CURRENT scheme: keep the real, clickable href and flag the link by setting this sentinel as the markdown
// link TITLE — `[label](real-url "<UNVERIFIED_TITLE>")`. The renderer styles it (dotted underline + a "?"
// marker) but leaves it a NORMAL clickable link, so a real link still works (and a fabricated one honestly
// 404s) while being visibly marked "we didn't verify this".
export const UNVERIFIED_TITLE = "§unverified§";

// LEGACY scheme: older persisted messages have the href itself re-pointed at this sentinel, rendering a
// NON-navigating reference. Kept ONLY so those messages (whose real URL was overwritten and is
// gone) still render as a marked, non-broken reference. New turns never emit this.
export const UNVERIFIED_HREF = "unverified:";
