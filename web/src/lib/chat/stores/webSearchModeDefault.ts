// The web-search mode a visitor starts in, from what their browser has stored. Kept apart from the
// store so it has no $app or svelte imports and its unit test can call it directly.
export type WebSearchMode = "off" | "auto" | "always";

export const KEY = "ap:webSearchMode";
// The default is auto, and KEY can't say who chose off: the store once wrote its value back on every
// page load, so a visitor who never touched the control can have "off" stored exactly like one who
// picked it. A choice made at the control is written to CHOICE_KEY, and only then, so CHOICE_KEY
// holds nothing but real choices. KEY is still read for what it can tell us: "auto" or "always" there
// was picked by a person (the default never wrote either), so it stands; "off" there is treated as
// the old default and becomes auto.
export const CHOICE_KEY = "ap:webSearchChoice";
// Legacy boolean key (webSearchAllowed): "0" was an explicit off in the toggle before the tri-state
// control, so it still means off.
const LEGACY_KEY = "ap:webSearchAllowed";
export const ORDER: WebSearchMode[] = ["off", "auto", "always"];
export const DEFAULT_MODE: WebSearchMode = "auto";

const isMode = (v: string | null): v is WebSearchMode => !!v && (ORDER as string[]).includes(v);

/** The mode a visitor starts in, from what their browser has stored. Pure over `read` for testing. */
export function resolveInitialWebSearchMode(read: (key: string) => string | null): WebSearchMode {
	const chosen = read(CHOICE_KEY);
	if (isMode(chosen)) return chosen;
	const stored = read(KEY);
	if (stored === "auto" || stored === "always") return stored;
	if (read(LEGACY_KEY) === "0") return "off";
	return DEFAULT_MODE;
}

