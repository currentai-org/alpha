// The application's own identity. Deliberately a CONSTANT, not env config: the name is
// "AI Potluck" in dev, preview, and production alike, and config that never varies by
// environment isn't environment config. Upstream chat-ui exposed this as PUBLIC_APP_NAME
// because HuggingChat is self-hosted by third parties who rebrand it; this fork has one name.
//
// Kept OUT of constants/share.ts on purpose. Those are share-campaign strings ("Kept in one
// place so the share sheet and the <meta> social card stay in sync"), and SHARE_TITLE only
// equals the app name by coincidence. Deriving the app name from SHARE_TITLE
// would couple the two, so tuning share copy would silently rename the app.
export const APP_NAME = "AI Potluck";

// Sent as User-Agent on outbound upstream calls (inference, search, rerank) so operators can
// attribute traffic to this deployment. One constant, since the deployment is always aipotluck.org.
export const APP_USER_AGENT = "aipotluck.org";
