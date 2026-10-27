import { describe, it, expect, vi, beforeEach } from "vitest";

// The registry is an exported `let` that models.ts reassigns after the live model list publishes,
// so the mock has to be reassignable too — that reassignment is the whole reason settingsSchema()
// is a function rather than a module-scope const, and a mock that pinned one value would test a
// shape the real code never has.
// Seeded at DECLARATION, not just in beforeEach, deliberately. The real models.ts always has some
// schema bound at import (a permissive bare `z.string()` until the live list publishes). Leaving
// this null until beforeEach would make a module-scope-capture regression crash on import instead of
// failing an assertion — which looks like a caught bug but is really the harness breaking, and
// proves nothing about whether the tripwire below bites.
const registry = { current: (await import("zod")).z.string() as unknown };
vi.mock("$lib/chat/server/models", () => ({
	get validModelIdSchema() {
		return registry.current;
	},
	// DEFAULT_SETTINGS.activeModel is a GETTER over this (types/Settings.ts) — a live binding so the
	// default tracks the published model list rather than freezing "" at import. The mock has to
	// supply it or every reference to the default throws before any assertion runs.
	defaultModel: { id: "vendor/default-model" },
}));
const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

const { z } = await import("zod");
const { settingsSchema } = await import("./settingsSchema");
const { DEFAULT_SETTINGS } = await import("$lib/chat/types/Settings");

/** Stands in for the published registry: only these ids exist, same as createValidModelIdSchema. */
const registryOf = (...ids: string[]) =>
	z.string().refine((v) => ids.includes(v), { message: "Invalid model id" });

describe("settingsSchema activeModel handling", () => {
	beforeEach(() => {
		warn.mockClear();
		registry.current = registryOf(DEFAULT_SETTINGS.activeModel, "vendor/registered-model");
	});

	it("passes a registered model id through untouched", () => {
		const out = settingsSchema().parse({ activeModel: "vendor/registered-model" });
		expect(out.activeModel).toBe("vendor/registered-model");
		expect(warn).not.toHaveBeenCalled();
	});

	// CUR-770's actual intent, and the thing that must NOT regress: an id the registry does not
	// know is never what gets persisted.
	it("never persists an unregistered model id", () => {
		const out = settingsSchema().parse({ activeModel: "vendor/rotated-out-of-the-pool" });
		expect(out.activeModel).not.toBe("vendor/rotated-out-of-the-pool");
		expect(out.activeModel).toBe(DEFAULT_SETTINGS.activeModel);
	});

	// The bug: a throw here becomes a 500 in SvelteKit and the whole write is lost. Injure the fix by
	// deleting the `.catch(...)` from settingsSchema.ts and this is the
	// test that goes red.
	it("does not throw when the model id has rotated out of the registry", () => {
		expect(() => settingsSchema().parse({ activeModel: "vendor/rotated-out-of-the-pool" })).not.toThrow();
	});

	// The collateral damage, stated as its own contract because it is the part users actually felt:
	// dismissing the onboarding modal persists through this endpoint, so a stale activeModel meant
	// the welcome modal came back on every visit.
	it("still records welcomeModalSeen alongside an unregistered model id", () => {
		const out = settingsSchema().parse({
			activeModel: "vendor/rotated-out-of-the-pool",
			welcomeModalSeen: true,
		});
		expect(out.welcomeModalSeen).toBe(true);
	});

	it("warns rather than coercing silently, naming the id it rejected", () => {
		settingsSchema().parse({ activeModel: "vendor/rotated-out-of-the-pool" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toMatchObject({ rejected: "vendor/rotated-out-of-the-pool" });
	});

	// settingsSchema() reads the registry at CALL time. If it ever captures at module scope again,
	// it would hold the permissive bare `z.string()` models.ts starts with and silently accept any
	// id — CUR-770 undone with every test still green. This is that tripwire.
	it("reads the registry at call time, not at import time", () => {
		registry.current = registryOf(DEFAULT_SETTINGS.activeModel, "only/this-one");
		expect(settingsSchema().parse({ activeModel: "only/this-one" }).activeModel).toBe("only/this-one");

		registry.current = registryOf(DEFAULT_SETTINGS.activeModel);
		expect(settingsSchema().parse({ activeModel: "only/this-one" }).activeModel).toBe(
			DEFAULT_SETTINGS.activeModel
		);
	});
});

describe("CUR-3528 settingsSchema Personalization cap", () => {
	beforeEach(() => {
		registry.current = registryOf(DEFAULT_SETTINGS.activeModel);
	});

	it("refuses Personalization text over the cap (it reaches every turn's system role)", async () => {
		const { CLIENT_INSTRUCTIONS_MAX_CHARS } = await import("./clientInstructions");
		const tooLong = "x".repeat(CLIENT_INSTRUCTIONS_MAX_CHARS + 1);
		expect(settingsSchema().safeParse({ customPrompts: { "*": tooLong } }).success).toBe(false);
		expect(
			settingsSchema().safeParse({ customPrompts: { "*": "x".repeat(CLIENT_INSTRUCTIONS_MAX_CHARS) } })
				.success
		).toBe(true);
	});

	it("leaves a per-model prompt to the create route's cap rather than refusing the whole settings write", async () => {
		const { CLIENT_INSTRUCTIONS_MAX_CHARS } = await import("./clientInstructions");
		const long = "x".repeat(CLIENT_INSTRUCTIONS_MAX_CHARS + 1);
		expect(settingsSchema().safeParse({ customPrompts: { "vendor/model": long } }).success).toBe(true);
	});
});

// The answer settings. A reset arrives as null and is accepted; a value outside the list is
// refused outright, never coerced, so an unknown tone cannot reach the prompt as a word with no clause. (CUR-3929)
describe("CUR-3929 settingsSchema answer preferences", () => {
	beforeEach(() => {
		registry.current = registryOf(DEFAULT_SETTINGS.activeModel);
	});

	it("accepts each listed value and null for every answer field", () => {
		const out = settingsSchema().parse({
			tone: "plain",
			answerLength: null,
			suggestions: false,
			answerLanguage: "pt",
			plainLanguage: null,
			selfReferenceAsPerson: null,
		});
		expect(out).toMatchObject({
			tone: "plain",
			answerLength: null,
			suggestions: false,
			answerLanguage: "pt",
			plainLanguage: null,
			selfReferenceAsPerson: null,
		});
		expect(settingsSchema().parse({ selfReferenceAsPerson: true })).toMatchObject({ selfReferenceAsPerson: true });
	});

	it("leaves an answer field out of the parse when the body did not send it", () => {
		const out = settingsSchema().parse({});
		for (const key of [
			"tone",
			"answerLength",
			"suggestions",
			"answerLanguage",
			"plainLanguage",
			"answerFormat",
			"emojis",
			"showServing",
			"selfReferenceAsPerson",
		]) {
			expect(key in out, `${key} was filled in by the schema`).toBe(false);
		}
	});

	it("refuses an unknown tone, length or language rather than coercing it", () => {
		expect(settingsSchema().safeParse({ tone: "warm" }).success).toBe(false);
		expect(settingsSchema().safeParse({ answerLength: "huge" }).success).toBe(false);
		expect(settingsSchema().safeParse({ answerLanguage: "xx" }).success).toBe(false);
		expect(settingsSchema().safeParse({ suggestions: "no" }).success).toBe(false);
	});

	it("takes the milestone 7 fields, set or null, and refuses a value outside their lists (CUR-549)", () => {
		const out = settingsSchema().parse({ answerFormat: "bullets", emojis: null, showServing: false });
		expect(out).toMatchObject({ answerFormat: "bullets", emojis: null, showServing: false });
		expect(settingsSchema().safeParse({ answerFormat: "table" }).success).toBe(false);
		expect(settingsSchema().safeParse({ emojis: "lots" }).success).toBe(false);
		expect(settingsSchema().safeParse({ showServing: "yes" }).success).toBe(false);
	});
});
