import { describe, expect, it } from "vitest";
import { describePlatform, suggestedPasskeyName } from "$lib/chat/utils/describePlatform";

const CHROME_MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const SAFARI_IOS =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const EDGE_WINDOWS =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";

describe("describePlatform", () => {
	it("names browser and OS together", () => {
		expect(describePlatform(CHROME_MAC)).toBe("Chrome on macOS");
		expect(describePlatform(SAFARI_IOS)).toBe("Safari on iOS");
		expect(describePlatform(FIREFOX_LINUX)).toBe("Firefox on Linux");
	});

	// Edge's UA also contains "Chrome" — must not fall through to the Chrome match first.
	it("checks Edge before Chrome, since Edge's UA string also contains 'Chrome'", () => {
		expect(describePlatform(EDGE_WINDOWS)).toBe("Edge on Windows");
	});

	it("returns null for an empty or fully unrecognized string", () => {
		expect(describePlatform("")).toBeNull();
		expect(describePlatform("some-custom-agent/1.0")).toBeNull();
	});
});

describe("suggestedPasskeyName", () => {
	const sept6 = new Date("2026-09-06T12:00:00Z");

	it("combines the platform description with the date", () => {
		expect(suggestedPasskeyName(CHROME_MAC, sept6)).toBe("Chrome on macOS · Sep 6");
	});

	// The person can still clear this and type their own name — this only covers the case where they
	// leave the prompt's suggested default in place, or where the platform can't be identified at all.
	it("falls back to a bare date label when the platform can't be identified", () => {
		expect(suggestedPasskeyName("unrecognized-agent", sept6)).toBe("Passkey · Sep 6");
	});
});
