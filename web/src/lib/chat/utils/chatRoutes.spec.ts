import { describe, expect, it } from "vitest";
import { isChatModelsRoute } from "./chatRoutes";

// ChatShell's generic OG/Twitter/JSON-LD social-card tags must be suppressed on a model's own page,
// which sets its own; otherwise it renders BOTH its own og:url (the real page) and ChatShell's
// (always the app root), a genuinely wrong/duplicated tag.
describe("isChatModelsRoute — the app-root social card must not leak onto a model's own page", () => {
	it("matches a model's own page", () => {
		expect(isChatModelsRoute("/chat/models/[...model]")).toBe(true);
	});

	it("does not match the dedicated chat route tree's other pages", () => {
		expect(isChatModelsRoute("/chat/conversation/[id]")).toBe(false);
		expect(isChatModelsRoute("/chat/settings/[...model]")).toBe(false);
	});

	it("does not match the Payload CMS catch-all route", () => {
		expect(isChatModelsRoute("/[...slug]")).toBe(false);
	});

	it("does not match an unrelated route that merely shares the string prefix", () => {
		expect(isChatModelsRoute("/chat/models-comparison")).toBe(false);
	});

	it("does not match a missing route id", () => {
		expect(isChatModelsRoute(undefined)).toBe(false);
		expect(isChatModelsRoute(null)).toBe(false);
	});
});
