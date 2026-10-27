import { beforeEach, describe, expect, it, vi } from "vitest";

// A key sent as null leaves the row through $unset, so a later read sees it unset; every
// other key is still $set, and a key the body did not send is not touched (CUR-1643). (CUR-3929)
const updateOne = vi.fn(async (_filter: unknown, _update: unknown) => ({
	acknowledged: true,
	matchedCount: 1,
	modifiedCount: 1,
	upsertedId: null,
}));
vi.mock("$lib/chat/server/database", () => ({
	collections: { settings: { updateOne: (filter: unknown, update: unknown) => updateOne(filter, update) } },
}));
vi.mock("$lib/chat/server/auth", () => ({ authCondition: () => ({ sessionId: "s1" }) }));
vi.mock("$lib/chat/server/config", () => ({ config: { isHuggingChat: false } }));
vi.mock("$lib/chat/server/localModels", async () => ({
	getEffectiveValidModelIdSchema: async () => (await import("zod")).z.string(),
	prewarmLocalModelForUser: async () => {},
}));
vi.mock("$lib/chat/server/vercelBackground", () => ({ runInBackground: async (p: Promise<unknown>) => p }));
vi.mock("$lib/chat/server/models", async () => ({
	validModelIdSchema: (await import("zod")).z.string(),
	defaultModel: { id: "vendor/default-model" },
}));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: () => {} } }));

const { applySettingsUpdate } = await import("./applySettingsUpdate");

type Update = { $set: Record<string, unknown>; $unset?: Record<string, true>; $setOnInsert: Record<string, unknown> };
const lastUpdate = () => updateOne.mock.calls.at(-1)?.[1] as unknown as Update;

beforeEach(() => {
	updateOne.mockClear();
});

describe("applySettingsUpdate (CUR-3929 resets)", () => {
	it("sets a sent value and unsets a sent null, in one write", async () => {
		await applySettingsUpdate({} as App.Locals, { tone: "plain", answerLength: null });
		const update = lastUpdate();
		expect(update.$set).toMatchObject({ tone: "plain" });
		expect("answerLength" in update.$set, "null reached $set").toBe(false);
		expect(update.$unset).toEqual({ answerLength: true });
	});

	it("sends no $unset when nothing was reset, so the write is what it was before resets existed", async () => {
		await applySettingsUpdate({} as App.Locals, { suggestions: false });
		const update = lastUpdate();
		expect(update.$set).toMatchObject({ suggestions: false });
		expect("$unset" in update).toBe(false);
	});

	it("touches only the keys the body sent", async () => {
		await applySettingsUpdate({} as App.Locals, { plainLanguage: true });
		const set = lastUpdate().$set;
		for (const key of ["tone", "answerLength", "suggestions", "answerLanguage", "streamingMode", "directPaste"]) {
			expect(key in set, `${key} was written although the body did not send it`).toBe(false);
		}
	});

	it("writes a preset body as one $set over exactly its fields, and nothing else (CUR-549)", async () => {
		const { PRESETS, PRESET_FIELDS } = await import("$lib/chat/answerPreferences");
		await applySettingsUpdate({} as App.Locals, { ...PRESETS.formal });
		const update = lastUpdate();
		for (const key of PRESET_FIELDS) expect(update.$set[key], key).toBe(PRESETS.formal[key]);
		for (const key of ["answerLanguage", "suggestions", "selfReferenceAsPerson", "showServing"]) {
			expect(key in update.$set, `${key} was written by a preset`).toBe(false);
		}
		expect("$unset" in update).toBe(false);
	});

	it("unsets a milestone 7 field sent as null and sets the receipt toggle like any other (CUR-549)", async () => {
		await applySettingsUpdate({} as App.Locals, { emojis: null, showServing: false });
		const update = lastUpdate();
		expect(update.$set).toMatchObject({ showServing: false });
		expect(update.$unset).toEqual({ emojis: true });
	});

	it("accepts an old client's explainTerms, off the page under rule 4.6, and writes nothing for it (CUR-4288)", async () => {
		for (const value of [true, null]) {
			await applySettingsUpdate({} as App.Locals, { explainTerms: value, tone: "plain" });
			const update = lastUpdate();
			expect(update.$set).toMatchObject({ tone: "plain" });
			expect("explainTerms" in update.$set, "explainTerms reached $set").toBe(false);
			expect("$unset" in update, "explainTerms reached $unset").toBe(false);
		}
	});

	it("refuses a value outside the list, writing nothing", async () => {
		await expect(applySettingsUpdate({} as App.Locals, { tone: "warm" })).rejects.toThrow();
		expect(updateOne).not.toHaveBeenCalled();
	});
});
