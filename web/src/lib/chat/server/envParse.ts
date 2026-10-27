// Env values pasted from docker/compose files (and some secret managers) sometimes keep their
// backtick wrapping — `{"foo":1}` arrives as the literal string with the backticks attached, which
// then fails JSON5.parse. This strips a single matched pair of surrounding backticks and falls back
// to a caller-supplied default when the value is empty. Three server sites parse JSON-ish env this
// way (models.ts, usageLimits.ts, login/callback/+server.ts); they share this one definition so the
// handling can't drift between them.
//
// The client has a sibling unquoter in $lib/chat/utils/featureAnnouncements.ts (unquoteEnv) with a
// deliberately different shape — no fallback, client layer — so it stays separate on purpose.
export const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};
