/**
 * eventWindow.ts against the real message_events table. The unit spec beside the module
 * mocks the collection, so only this file shows the filters it builds actually select the rows a
 * limit means to count: the right key, unexpired only, and nothing from a neighbouring key. (CUR-2120)
 */
import { afterEach, describe, expect, it } from "vitest";
import { collections } from "$lib/chat/server/database";
import {
	clearEvents,
	countLiveEvents,
	recordEvent,
	recordEvents,
	underEventLimit,
} from "$lib/chat/server/db/eventWindow";

const TYPE = `eventWindowSpec:${crypto.randomUUID()}`;

afterEach(async () => {
	await collections.messageEvents.deleteMany({ type: TYPE });
});

describe("eventWindow against Postgres", () => {
	it("refuses once a key reaches its limit and leaves a different key alone", async () => {
		for (let i = 0; i < 3; i++) await recordEvent({ type: TYPE, ipHash: "a" }, 60_000, "spec");
		await recordEvent({ type: TYPE, ipHash: "b" }, 60_000, "spec");

		await expect(countLiveEvents({ type: TYPE, ipHash: "a" }, "spec")).resolves.toBe(3);
		await expect(underEventLimit({ type: TYPE, ipHash: "a" }, 3, "spec")).resolves.toBe(false);
		await expect(underEventLimit({ type: TYPE, ipHash: "b" }, 3, "spec")).resolves.toBe(true);
	});

	it("matches on both columns when a key carries two hashes", async () => {
		await recordEvent({ type: TYPE, ipHash: "ip", userId: "target-1" }, 60_000, "spec");
		await expect(
			countLiveEvents({ type: TYPE, ipHash: "ip", userId: "target-1" }, "spec")
		).resolves.toBe(1);
		await expect(
			countLiveEvents({ type: TYPE, ipHash: "ip", userId: "target-2" }, "spec")
		).resolves.toBe(0);
	});

	it("stops counting a row once its window has passed, which is what makes the limit slide", async () => {
		await recordEvent({ type: TYPE, userId: "u" }, 60_000, "spec");
		await recordEvent({ type: TYPE, userId: "u" }, -1_000, "spec");
		await expect(countLiveEvents({ type: TYPE, userId: "u" }, "spec")).resolves.toBe(1);
	});

	it("clears one key's rows and no other's", async () => {
		await recordEvent({ type: TYPE, ipHash: "a" }, 60_000, "spec");
		await recordEvent({ type: TYPE, ipHash: "b" }, 60_000, "spec");
		await clearEvents({ type: TYPE, ipHash: "a" }, "spec");
		await expect(countLiveEvents({ type: TYPE, ipHash: "a" }, "spec")).resolves.toBe(0);
		await expect(countLiveEvents({ type: TYPE, ipHash: "b" }, "spec")).resolves.toBe(1);
	});

	it("records several rows in one write, each counting against the key, as a turn's screening charge does (CUR-3532)", async () => {
		await recordEvents({ type: TYPE, userId: "u", ipHash: "ip" }, 8, 60_000, "spec");
		await recordEvents({ type: TYPE, userId: "u", ipHash: "ip" }, 0, 60_000, "spec");
		await expect(countLiveEvents({ type: TYPE, userId: "u" }, "spec")).resolves.toBe(8);
		await expect(countLiveEvents({ type: TYPE, ipHash: "ip" }, "spec")).resolves.toBe(8);
	});
});
