import { describe, expect, it } from "vitest";
import { GUARDS_ONLY_SECTIONS, NATIVE_SECTIONS } from "./promptSections";
import { PERSONA_SECTIONS } from "./persona";
import { renderSections, type PromptSection } from "./renderSections";
import { IMAGE_RULE } from "../search/classifierPrompt";
import { ATTACHED_DOCUMENT_NOTE } from "./grounding";

// The native prompt's sections, in the order they render. A change here is a change to what
// every native model is told, so it shows up as a diff on this list as well as on the
// turnRequest snapshots. The date renders last (CUR-3918); CUR-3892 moves every other `turn` section
// after the last `static` one. (CUR-3899)
describe("NATIVE_SECTIONS", () => {
	it("renders these sections in this order, each with its stability class", () => {
		expect(NATIVE_SECTIONS.map((s) => `${s.id}:${s.stability}`)).toEqual([
			"identity:turn",
			"identity-honesty:static",
			"identity-account-lock:static",
			"crisis-and-values:static",
			"rights-and-benefits:static",
			"investment-risk:static",
			"screening:deployment",
			"account:turn",
			"app-facts:turn",
			"answer-style:turn",
			"answer-shape:turn",
			"search:turn",
			"photo-search:turn",
			"attached-document:turn",
			"link-off-by-search:turn",
			"catalog-tool:static",
			"calculate-first:static",
			"datetime-tool:static",
			"citations:static",
			"visitor-sources:turn",
			"source-fidelity:static",
			"serving:turn",
			"fence:turn",
			"date:turn",
		]);
	});

	it("names each section once and cites a ticket for each", () => {
		const ids = NATIVE_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of [...NATIVE_SECTIONS, ...GUARDS_ONLY_SECTIONS, ...PERSONA_SECTIONS]) expect(s.ticket).toMatch(/^CUR-\d+$/);
	});
});

// The guards-only (minimal) prompt's sections, in the order they render. It shares the base
// guard list with the native prompt, so `answer-style` has to sit here too, or the five answer settings
// reach every native model and no scaffolded one on its minimal path (plan 4.3's carrier table). (CUR-3929)
describe("GUARDS_ONLY_SECTIONS", () => {
	it("renders these sections in this order, each with its stability class", () => {
		expect(GUARDS_ONLY_SECTIONS.map((s) => `${s.id}:${s.stability}`)).toEqual([
			"identity:turn",
			"identity-honesty:static",
			"identity-account-lock:static",
			"crisis-and-values:static",
			"rights-and-benefits:static",
			"investment-risk:static",
			"screening:deployment",
			"account:turn",
			"app-facts:turn",
			"answer-style:turn",
			"calculate-first:static",
			"date:turn",
		]);
	});
});

// The native model decides its own searches, so on a photo turn it gets the rule the scaffolded
// turn's search decider gets (CUR-3192). Without it a model can search the web for a logo it was shown. (CUR-4015)
describe("the photo search rule", () => {
	const ctx = {
		modelId: "mistral-large-2512",
		account: { loginOffered: true, signedIn: false },
		fence: "turn_x",
		web: true,
		screeningFacts: undefined,
		today: "Monday, 12 October 2026",
	} as const;
	const said = (extra: object) => renderSections(NATIVE_SECTIONS, { ...ctx, ...extra });

	it("tells a native model with a photo to search only for what the photo can't show", () => {
		expect(said({ photoAttached: true })).toContain(IMAGE_RULE);
	});

	it("is left out when no photo came with the message, when search is off, and on an unservable live question", () => {
		expect(said({})).not.toContain(IMAGE_RULE);
		expect(said({ photoAttached: true, web: false })).not.toContain(IMAGE_RULE);
		expect(said({ photoAttached: true, unservableLive: true })).not.toContain(IMAGE_RULE);
	});
});

// A native turn never runs hardenLastUserTurn, so the note asking the answer to name the attached
// document rides the system prompt instead; without it the note reached no turn with search on. (CUR-4102)
describe("the attached document note", () => {
	const said = (extra: object) =>
		renderSections(NATIVE_SECTIONS, {
			modelId: "mistral-small-2603",
			account: { loginOffered: true, signedIn: false },
			fence: "turn_x",
			web: true,
			screeningFacts: undefined,
			today: "Monday, 12 October 2026",
			...extra,
		});

	it("asks a native model to name a document attached in the conversation", () => {
		expect(said({ documentAttached: true })).toContain(ATTACHED_DOCUMENT_NOTE);
	});

	it("is left out of a turn with no attached document, so that prompt is unchanged", () => {
		expect(said({})).not.toContain(ATTACHED_DOCUMENT_NOTE);
		expect(said({ documentAttached: false })).toBe(said({}));
	});
});

// The scaffolded turn's persona, the prompt production sends. (CUR-3900)
describe("PERSONA_SECTIONS", () => {
	it("renders these sections in this order, each with its stability class", () => {
		expect(PERSONA_SECTIONS.map((s) => `${s.id}:${s.stability}`)).toEqual([
			"date:turn",
			"persona:turn",
			"app-facts:turn",
			"calculate-first:static",
		]);
	});
});

// Two turns on different days to the same model send the same prompt up to the date, so a
// provider can cache everything before it. The persona keeps its date first, because a date moved last
// can leave a model answering a Tokyo guest's date question a day late. (CUR-3918)
describe("the date", () => {
	const base = { modelId: "mistral-large-2512", account: { loginOffered: true, signedIn: false } } as const;

	it("is the last paragraph of the native prompt, and nothing before it changes with the day", () => {
		const ctx = { ...base, fence: "turn_x", web: true, screeningFacts: undefined };
		const monday = renderSections(NATIVE_SECTIONS, { ...ctx, today: "Monday, 12 October 2026" });
		const tuesday = renderSections(NATIVE_SECTIONS, { ...ctx, today: "Tuesday, 13 October 2026" });
		expect(monday.split("\n\n").at(-1)).toBe("Today is Monday, 12 October 2026.");
		expect(monday.replace(/Today is [^\n]*$/, "")).toBe(tuesday.replace(/Today is [^\n]*$/, ""));
	});

	it("is the last paragraph of the guards-only prompt", () => {
		const out = renderSections(GUARDS_ONLY_SECTIONS, { ...base, today: "Monday, 12 October 2026", calculateTool: true });
		expect(out.split("\n\n").at(-1)).toBe("Today is Monday, 12 October 2026.");
	});

	it("stays the first paragraph of the persona, where a Tokyo guest gets the right day", () => {
		const out = renderSections(PERSONA_SECTIONS, {
			modelId: "mistral-large-2512",
			opts: { today: "Monday, 12 October 2026", calculateTool: true },
		});
		expect(out.split("\n\n")[0]).toBe("Today is Monday, 12 October 2026 where the person asking is.");
	});
});

describe("renderSections", () => {
	const sections: PromptSection<{ on: boolean }>[] = [
		{ id: "a", stability: "static", ticket: "CUR-1", render: () => "A" },
		{ id: "b", stability: "turn", ticket: "CUR-1", when: ({ on }) => on, render: () => ["B1", "B2"] },
		{ id: "c", stability: "static", ticket: "CUR-1", render: () => "" },
	];

	it("leaves out a section whose condition is false, and keeps an empty one as a paragraph", () => {
		expect(renderSections(sections, { on: false })).toBe("A\n\n");
	});

	it("renders a section's several strings as separate paragraphs", () => {
		expect(renderSections(sections, { on: true })).toBe("A\n\nB1\n\nB2\n\n");
	});
});
