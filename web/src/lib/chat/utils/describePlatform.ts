// No rename-after-creation call exists in Better Auth's client SDK for passkeys, so whatever
// name is set at registration is the only shot at telling credentials apart later. Simpler fallback
// named in the ticket rather than an AAGUID-registry lookup: a suggested default built from the
// browser + OS + today's date, editable before the ceremony completes. Pure and testable — takes the
// UA string as an argument rather than reading `navigator` itself. (CUR-649)
const BROWSERS: [RegExp, string][] = [
	[/edg\//i, "Edge"],
	[/opr\/|opera/i, "Opera"],
	[/chrome|crios/i, "Chrome"],
	[/firefox|fxios/i, "Firefox"],
	[/safari/i, "Safari"],
];

const PLATFORMS: [RegExp, string][] = [
	[/iphone|ipad|ipod/i, "iOS"],
	[/android/i, "Android"],
	[/mac os x/i, "macOS"],
	[/windows/i, "Windows"],
	[/linux/i, "Linux"],
];

function matchFirst(userAgent: string, table: [RegExp, string][]): string | null {
	for (const [pattern, name] of table) {
		if (pattern.test(userAgent)) return name;
	}
	return null;
}

/** "Chrome on macOS", "Safari on iOS", or just "Chrome"/"macOS" alone if only one side matches. Null
 * for an empty or fully unrecognized string — the caller falls back to a plain "Passkey" label. */
export function describePlatform(userAgent: string): string | null {
	const browserName = matchFirst(userAgent, BROWSERS);
	const platformName = matchFirst(userAgent, PLATFORMS);
	if (browserName && platformName) return `${browserName} on ${platformName}`;
	return browserName ?? platformName;
}

/** Suggested passkey name: platform description + today's date, e.g. "Chrome on macOS · Sep 6". Used
 * to pre-fill the naming prompt and as the fallback when the person leaves it blank. */
export function suggestedPasskeyName(userAgent: string, now: Date = new Date()): string {
	const platform = describePlatform(userAgent);
	const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	return platform ? `${platform} · ${date}` : `Passkey · ${date}`;
}
