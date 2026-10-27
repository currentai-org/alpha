import { describe, expect, it } from "vitest";
import { isActiveConversationId } from "./conversationId";

// CUR: sidebar rows loaded via infinite-scroll pagination carry an ObjectId INSTANCE (not a plain
// string) for `conv.id`, thanks to a superjson round-trip (see conversationId.ts's own comment) —
// so the active-row highlight must survive that, not just the plain-string case the first page of
// conversations happens to already be in.
describe("isActiveConversationId — sidebar active-row highlight survives a non-string id", () => {
	it("matches when both sides are the same plain string (first-page conversations)", () => {
		expect(isActiveConversationId("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011")).toBe(
			true
		);
	});

	it("matches an ObjectId-like object whose toString() equals the route param (paginated conversations)", () => {
		const objectIdLike = { toString: () => "507f1f77bcf86cd799439011" };
		expect(isActiveConversationId(objectIdLike, "507f1f77bcf86cd799439011")).toBe(true);
	});

	it("does not match a different conversation's id", () => {
		expect(isActiveConversationId("507f1f77bcf86cd799439011", "000000000000000000000000")).toBe(
			false
		);
	});

	it("does not match when there is no route param (e.g. the empty composer, not a conversation page)", () => {
		expect(isActiveConversationId("507f1f77bcf86cd799439011", undefined)).toBe(false);
	});
});
