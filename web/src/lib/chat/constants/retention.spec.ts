/**
 * The delete-date banner's date maths: a chat shows "This chat is deleted on <date>" with
 * Export and Continue from day 23 of its 30, counted from creation, or from launch day for a chat that
 * predates expiry. The conversation page and the sweep read the same conversationExpiresAt.
 */
import { describe, expect, it } from "vitest";
import { conversationExpiresAt, daysUntil, expiryWarningShows } from "./retention";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2031-06-15T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const longAgoLaunch = ago(365);

describe("delete-date banner", () => {
	it("shows on a chat created 24 days ago, 6 days before its date", () => {
		const expires = conversationExpiresAt(ago(24), longAgoLaunch, now);
		expect(daysUntil(expires, now)).toBe(6);
		expect(expiryWarningShows(expires, now)).toBe(true);
	});

	it("does not show on a chat created 10 days ago", () => {
		const expires = conversationExpiresAt(ago(10), longAgoLaunch, now);
		expect(daysUntil(expires, now)).toBe(20);
		expect(expiryWarningShows(expires, now)).toBe(false);
	});

	it("starts exactly at day 23 and not a minute before", () => {
		const atDay23 = conversationExpiresAt(ago(23), longAgoLaunch, now);
		expect(expiryWarningShows(atDay23, now)).toBe(true);
		const justBefore = conversationExpiresAt(new Date(ago(23).getTime() + 60_000), longAgoLaunch, now);
		expect(expiryWarningShows(justBefore, now)).toBe(false);
	});

	it("never shows on an old chat before launch day plus 23: launch day restarts its clock", () => {
		const launchedFiveDaysAgo = ago(5);
		const expires = conversationExpiresAt(ago(200), launchedFiveDaysAgo, now);
		expect(daysUntil(expires, now)).toBe(25);
		expect(expiryWarningShows(expires, now)).toBe(false);
	});

	it("keeps showing past the date, until the sweep takes the chat", () => {
		const expires = conversationExpiresAt(ago(31), longAgoLaunch, now);
		expect(daysUntil(expires, now)).toBe(0);
		expect(expiryWarningShows(expires, now)).toBe(true);
	});

	it("with no launch recorded yet, counts from now: nothing warns before the first sweep", () => {
		const expires = conversationExpiresAt(ago(100), null, now);
		expect(daysUntil(expires, now)).toBe(30);
		expect(expiryWarningShows(expires, now)).toBe(false);
	});
});
