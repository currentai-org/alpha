import { describe, expect, it, vi } from "vitest";
import { PICKER, pickerSites } from "../../../../config/inference";
import { resolveModelIdentity } from "$lib/chat/identity";
import { catalogBaseOf } from "$lib/chat/routing/catalog";

const error = vi.fn();
vi.mock("./logger", () => ({ logger: { error: (...a: unknown[]) => error(...a), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const { replyLanguageRuleFits } = await import("./harnessProfiles");

// Every id any site's picker offers (CUR-3484). A model reaches a visitor only through one of these
// lists, so each needs what the turn and the provenance badge read: a harness row, a named maker, and
// a routing-catalog entry for the picker's name and the map node.
const offered = [...new Set(pickerSites.flatMap((s) => PICKER[s]))];

describe("every picker id is wired before a visitor can choose it (CUR-3484)", () => {
	it("has a harness profile row, so no picker model gets the plain harness unseen", () => {
		error.mockClear();
		for (const id of offered) replyLanguageRuleFits(id);
		expect(error.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual([]);
	});

	it("has a routing-catalog row, or is a reasoning variant of one", () => {
		expect(offered.filter((id) => !catalogBaseOf(id))).toEqual([]);
	});

	// identity.ts names a model by its own branch, or else by its catalog name with a generic maker. An id
	// with neither shows the visitor a name derived from the raw id.
	it("gets an identity branch or its catalog name, never a name made from the raw id", () => {
		const unnamed = offered.filter((id) => {
			const who = resolveModelIdentity(id);
			return who.makerShort === "open source" && who.short !== catalogBaseOf(id)?.name;
		});
		expect(unnamed).toEqual([]);
	});
});
