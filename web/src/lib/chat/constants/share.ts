// Prewritten share copy + the social-card strings. We share the site (not a
// private conversation), with a non-personal `?ref=share` tag the already-wired GTM can attribute.
// Kept in one place so the share sheet and the <meta> social card stay in sync.

export const SHARE_TITLE = "AI Potluck";

// Appended after the app name on social cards and the browser tab → "AI Potluck — public, open,
// not-for-profit AI" (CUR-4325). Matches the landing headline (copy_landingHeadline).
export const SHARE_TAGLINE = "public, open, not-for-profit AI";

// Used for the native share sheet's text AND the og/twitter:description, so a shared link
// reads the same wherever it lands. Plain, non-hype voice.
export const SHARE_TEXT =
	"A public, open source AI you can actually use — and see what's behind every answer.";

// Non-personal campaign tag on the shared URL (never anything user-identifying — privacy rule).
export const SHARE_REF = "share";

// OG/Twitter card image (1200×630), served from static/.
export const SHARE_IMAGE = "/alpha-og.png";
