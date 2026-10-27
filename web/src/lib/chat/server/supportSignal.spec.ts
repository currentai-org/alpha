import { describe, expect, it, vi } from "vitest";
import {
	parseSupportArgs,
	SIGNAL_MAX_CHARS,
	stampSupportFromSignal,
	supportSignal,
	SUPPORT_TOOL_NAME,
	type SupportCall,
	type SupportRecord,
	type SupportSignal,
} from "./supportSignal";

const quiet = { info: vi.fn(), warn: vi.fn() };
const toolCall = (args: unknown, name = SUPPORT_TOOL_NAME) => ({
	function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

describe("supportSignal (CUR-4093)", () => {
	it("returns the classifier's show:true with who and language", async () => {
		const call: SupportCall = async () => ({ show: true, who: "someone_else", lang: "es", country: "" });
		await expect(supportSignal("Mi amiga me dijo que ya no quiere vivir", { call, logger: quiet })).resolves.toEqual({
			show: true,
			who: "someone_else",
			lang: "es",
			country: "",
		});
	});

	it("never rejects: a throwing call resolves null, so the guard's result stands", async () => {
		const call: SupportCall = async () => {
			throw new Error("gateway down");
		};
		await expect(supportSignal("je n'y arrive plus", { call, logger: quiet })).resolves.toBeNull();
	});

	it("does not call the model for an empty message", async () => {
		const call = vi.fn<SupportCall>();
		await expect(supportSignal("   ", { call, logger: quiet })).resolves.toBeNull();
		expect(call).not.toHaveBeenCalled();
	});

	it("sends only the tail of a long message, where distress after a paste sits", async () => {
		const call = vi.fn<SupportCall>(async () => null);
		const text = "x".repeat(SIGNAL_MAX_CHARS) + "I can't go on";
		await supportSignal(text, { call, logger: quiet });
		const sent = call.mock.calls[0][0];
		expect(sent.length).toBe(SIGNAL_MAX_CHARS);
		expect(sent.endsWith("I can't go on")).toBe(true);
	});

	it("logs outcome, who and language but never the message text", async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const call: SupportCall = async () => ({ show: true, who: "writer", lang: "sw", country: "" });
		await supportSignal("Sioni sababu ya kuendelea", { call, logger });
		const [fields] = logger.info.mock.calls[0];
		expect(fields).toMatchObject({ outcome: "show", who: "writer", lang: "sw" });
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain("Sioni");
	});

	it("logs a failed call at warn, since it can cost a person in distress the card", async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		await supportSignal("je n'y arrive plus", { call: async () => null, logger });
		expect(logger.warn.mock.calls[0][0]).toMatchObject({ outcome: "failed" });
		expect(logger.info).not.toHaveBeenCalled();
	});
});

const MSG = "je n'y arrive plus";

describe("parseSupportArgs", () => {
	it("reads show, who and a normalized primary language subtag", () => {
		expect(parseSupportArgs(toolCall({ show: true, who: "writer", lang: "fr-FR" }), MSG)).toEqual({
			show: true,
			who: "writer",
			lang: "fr",
			country: "",
		});
	});

	it("keeps show:true when who or lang is missing or odd, rather than dropping the card", () => {
		expect(parseSupportArgs(toolCall({ show: true, who: "friend" }), MSG)).toEqual({ show: true, who: "none", lang: "", country: "" });
	});

	it("drops a lang that is not a 2-3 letter primary subtag, keeping show", () => {
		for (const lang of ["french", "f", "12", "zh!", "<b>"]) {
			expect(parseSupportArgs(toolCall({ show: true, who: "writer", lang }), MSG)).toEqual({
				show: true,
				who: "writer",
				lang: "",
				country: "",
			});
		}
		expect(parseSupportArgs(toolCall({ show: true, who: "writer", lang: "HAW" }), MSG)?.lang).toBe("haw");
	});

	it("reads the country the message places the person at risk in, lower-cased (CUR-4488)", () => {
		const pt = "Trabalho na Segurança Social e um beneficiário diz que já não quer viver.";
		expect(parseSupportArgs(toolCall({ show: true, who: "someone_else", lang: "pt", place: "segurança social", country: "PT" }), pt)?.country).toBe("pt");
		const fr = "Je suis professeure à Lyon. Un élève n'a plus envie de vivre.";
		expect(parseSupportArgs(toolCall({ show: true, who: "someone_else", lang: "fr", place: "Lyon", country: "fr" }), fr)?.country).toBe("fr");
	});

	it("drops a country whose place the person never wrote, so a French message with no place gets the front page, not France's (CUR-4488)", () => {
		const text = "Je ne veux plus vivre. 1792859723943";
		for (const place of ["", "France", "français", "e"]) {
			expect(parseSupportArgs(toolCall({ show: true, who: "writer", lang: "fr", place, country: "fr" }), text)).toEqual({
				show: true,
				who: "writer",
				lang: "fr",
				country: "",
			});
		}
	});

	it("drops a country findahelpline has no page for, so the card falls back to the IP country rather than a dead link (CUR-4488)", () => {
		for (const country of ["france", "xx", "f", "<b>", 33, null]) {
			const sig = parseSupportArgs(toolCall({ show: true, who: "writer", lang: "fr", place: "Lyon", country }), "à Lyon");
			expect(sig).toEqual({ show: true, who: "writer", lang: "fr", country: "" });
		}
	});

	it("returns null for the wrong tool, a non-boolean show, or unparseable arguments", () => {
		expect(parseSupportArgs(toolCall({ show: true, who: "writer", lang: "en" }, "other_tool"), MSG)).toBeNull();
		expect(parseSupportArgs(toolCall({ show: "yes", who: "writer", lang: "en" }), MSG)).toBeNull();
		expect(parseSupportArgs(toolCall("{not json"), MSG)).toBeNull();
		expect(parseSupportArgs(undefined, MSG)).toBeNull();
	});
});

describe("stampSupportFromSignal: the card from the signal, and whether the turn carries support (CUR-4093)", () => {
	const sig = (v: SupportSignal | null) => Promise.resolve(v);

	it("a show:true stamps support and the language, emits the notice once, and resolves true", async () => {
		const record: SupportRecord = {};
		const emit = vi.fn(async () => {});
		await expect(stampSupportFromSignal(record, sig({ show: true, who: "writer", lang: "sw", country: "" }), emit)).resolves.toBe(true);
		expect(record).toEqual({ support: true, supportLang: "sw" });
		expect(emit).toHaveBeenCalledExactlyOnceWith({ supportLang: "sw" });
	});

	it("names the language on a card the guard already stamped, even when the signal says no", async () => {
		for (const show of [true, false]) {
			const record: SupportRecord = { support: true };
			const emit = vi.fn(async () => {});
			await expect(stampSupportFromSignal(record, sig({ show, who: "writer", lang: "fr", country: "" }), emit)).resolves.toBe(true);
			expect(record).toEqual({ support: true, supportLang: "fr" });
			expect(emit).toHaveBeenCalledExactlyOnceWith({ supportLang: "fr" });
		}
	});

	it("leaves a guard stamp as it is when the signal fails or the language is already set", async () => {
		const emit = vi.fn(async () => {});
		const failed: SupportRecord = { support: true };
		await expect(stampSupportFromSignal(failed, sig(null), emit)).resolves.toBe(true);
		expect(failed).toEqual({ support: true });
		const named: SupportRecord = { support: true, supportLang: "de" };
		await expect(stampSupportFromSignal(named, sig({ show: true, who: "writer", lang: "fr", country: "" }), emit)).resolves.toBe(true);
		expect(named).toEqual({ support: true, supportLang: "de" });
		expect(emit).not.toHaveBeenCalled();
	});

	it("records and emits the named country beside the language, on its own stamp or the guard's (CUR-4488)", async () => {
		const fresh: SupportRecord = {};
		const emit = vi.fn(async () => {});
		await stampSupportFromSignal(fresh, sig({ show: true, who: "someone_else", lang: "fr", country: "fr" }), emit);
		expect(fresh).toEqual({ support: true, supportLang: "fr", supportCountry: "fr" });
		expect(emit).toHaveBeenCalledExactlyOnceWith({ supportLang: "fr", supportCountry: "fr" });

		const guardStamped: SupportRecord = { support: true, supportLang: "pt" };
		const emit2 = vi.fn(async () => {});
		await stampSupportFromSignal(guardStamped, sig({ show: false, who: "none", lang: "pt", country: "pt" }), emit2);
		expect(guardStamped).toEqual({ support: true, supportLang: "pt", supportCountry: "pt" });
		expect(emit2).toHaveBeenCalledExactlyOnceWith({ supportCountry: "pt" });
	});

	it("never stamps a country on a turn without support, so an ordinary answer's card cannot appear", async () => {
		const record: SupportRecord = {};
		await expect(
			stampSupportFromSignal(record, sig({ show: false, who: "none", lang: "fr", country: "fr" }), async () => {})
		).resolves.toBe(false);
		expect(record).toEqual({});
	});

	it("a show:false or a failed call leaves the record alone and resolves false", async () => {
		for (const s of [sig({ show: false, who: "none", lang: "en", country: "" }), sig(null), Promise.reject(new Error("x"))]) {
			const record: SupportRecord = {};
			const emit = vi.fn(async () => {});
			await expect(stampSupportFromSignal(record, s, emit)).resolves.toBe(false);
			expect(record).toEqual({});
			expect(emit).not.toHaveBeenCalled();
		}
	});

	it("resolves only after the late signal lands, so a reader awaiting it sees the stamp", async () => {
		let land!: (v: SupportSignal) => void;
		const late = new Promise<SupportSignal>((r) => (land = r));
		const record: SupportRecord = {};
		const verdict = stampSupportFromSignal(record, late, async () => {});
		let settled = false;
		void verdict.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		land({ show: true, who: "someone_else", lang: "es", country: "" });
		await expect(verdict).resolves.toBe(true);
		expect(record.support).toBe(true);
	});

	it("keeps the stamp when emitting the notice fails, so the final persist still carries the card", async () => {
		const record: SupportRecord = {};
		const emit = vi.fn(async () => {
			throw new Error("stream closed");
		});
		await expect(stampSupportFromSignal(record, sig({ show: true, who: "writer", lang: "", country: "" }), emit)).resolves.toBe(true);
		expect(record).toEqual({ support: true });
		expect(emit).toHaveBeenCalledWith({});
	});
});
