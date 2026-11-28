// Qwen3Guard's categories onto our rules. The map is the contract: which rule each label fires, which
// labels fire nothing, and that a verdict the adapter cannot read is unknown, never a pass.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import {
	QWEN3GUARD_MODEL,
	QWEN_MAPPED_RULES,
	categoryOf,
	makeQwen3GuardJudge,
	parseQwen3GuardOutput,
	ruleState,
	type QwenVerdict,
} from "./qwen3guard";
import { SHIELDSTRAL_PAIRED_RULES } from "../../../../../config/safetyScreen";

const unsafe = (...labels: string[]): QwenVerdict => ({ verdict: "unsafe", categories: labels.map(categoryOf) });
const allRules = () => loadGuardPolicy()!.entries.map((r) => r.key);
const firing = (v: QwenVerdict) => allRules().filter((k) => ruleState(k, v) === "yes");
const unknownFor = (v: QwenVerdict) => allRules().filter((k) => ruleState(k, v) === "unknown");

describe("parsing the verdict", () => {
	it("reads the verdict and the category list", () => {
		expect(parseQwen3GuardOutput("Safety: Unsafe\nCategories: Violent, PII")).toEqual({
			verdict: "unsafe",
			categories: ["violent", "pii"],
		});
		expect(parseQwen3GuardOutput("Safety: Safe\nCategories: None")).toEqual({ verdict: "safe", categories: ["none"] });
		expect(parseQwen3GuardOutput("Safety: Controversial\nCategories: Unethical Acts")?.verdict).toBe("controversial");
	});

	it("tells Non-violent Illegal Acts from Violent", () => {
		expect(categoryOf("Non-violent Illegal Acts")).toBe("illegal");
		expect(categoryOf("Violent")).toBe("violent");
	});

	it("is null for output that is not a verdict", () => {
		expect(parseQwen3GuardOutput("I cannot help with that")).toBeNull();
		expect(parseQwen3GuardOutput(undefined)).toBeNull();
	});
});

describe("which rules each category fires", () => {
	it("fires violence from Violent only", () => {
		expect(firing(unsafe("Violent"))).toEqual(["chat-block-violence"]);
	});
	it("fires eating from Suicide & Self-Harm, and the other self-harm rules never from Qwen3Guard", () => {
		expect(firing(unsafe("Suicide & Self-Harm"))).toEqual(["chat-block-self-harm", "chat-block-self-harm-eating"]);
		expect(ruleState("chat-block-self-harm-passive", unsafe("Suicide & Self-Harm"))).toBe("no");
		expect(ruleState("chat-block-self-harm-intent", unsafe("Suicide & Self-Harm"))).toBe("no");
		expect(ruleState("chat-block-self-harm-hedged", unsafe("Suicide & Self-Harm"))).toBe("no");
	});
	it("fires sexual from Sexual Content or Sexual Acts", () => {
		expect(firing(unsafe("Sexual Content or Sexual Acts"))).toEqual(["chat-block-sexual"]);
	});
	it("fires drugs and fraud from Non-violent Illegal Acts, privacy from PII", () => {
		expect(firing(unsafe("Non-violent Illegal Acts"))).toEqual(["chat-block-drugs", "chat-block-fraud"]);
		expect(firing(unsafe("PII"))).toEqual(["chat-block-privacy"]);
	});
	it("fires all four respect rules from Unethical Acts", () => {
		expect(firing(unsafe("Unethical Acts"))).toEqual([
			"chat-block-harrasment",
			"chat-block-toxic",
			"chat-block-hate",
			"chat-block-hate-advocacy",
		]);
	});
	it("never fires anthro", () => {
		for (const l of ["Violent", "Sexual Content or Sexual Acts", "Unethical Acts", "Suicide & Self-Harm"]) {
			expect(ruleState("chat-block-anthro", unsafe(l))).toBe("no");
		}
	});
	it("fires nothing for Politically Sensitive Topics, Copyright Violation or Jailbreak", () => {
		for (const l of ["Politically Sensitive Topics", "Copyright Violation", "Jailbreak"]) {
			const v = unsafe(l);
			expect(firing(v)).toEqual([]);
			expect(unknownFor(v)).toEqual([]);
		}
	});
	it("answers no everywhere for Safe, and for Controversial", () => {
		expect(firing({ verdict: "safe", categories: ["none"] })).toEqual([]);
		expect(firing({ verdict: "controversial", categories: ["violent"] })).toEqual([]);
	});
	it("reads an Unsafe with no recognised category as unknown on every rule", () => {
		expect(unknownFor(unsafe("None"))).toEqual(allRules());
		expect(unknownFor(unsafe("Something New"))).toEqual(allRules());
	});
});

describe("the child rules without the pairing", () => {
	const child = ["chat-block-child-sexual-content", "chat-block-child-grooming"];
	it("reads Sexual Content and Unethical Acts as unknown, which the gate fails closed on", () => {
		expect(unknownFor(unsafe("Sexual Content or Sexual Acts"))).toEqual(child);
		expect(unknownFor(unsafe("Unethical Acts"))).toEqual(child);
	});
	it("never fires a child rule from a label, and reads other labels as no", () => {
		expect(firing(unsafe("Sexual Content or Sexual Acts", "Unethical Acts")).filter((k) => child.includes(k))).toEqual([]);
		expect(unknownFor(unsafe("Violent"))).toEqual([]);
	});
});

describe("the map covers the policy", () => {
	it("names no rule the policy lacks, and every policy rule is mapped, paired or documented as never firing", () => {
		const keys = new Set(allRules());
		for (const k of [...QWEN_MAPPED_RULES, ...SHIELDSTRAL_PAIRED_RULES]) expect(keys.has(k), k).toBe(true);
		const neverFromQwen = [
			"chat-block-self-harm-intent",
			"chat-block-self-harm-passive",
			"chat-block-self-harm-hedged",
			"chat-block-prompt",
		];
		const unaccounted = [...keys].filter(
			(k) => !QWEN_MAPPED_RULES.includes(k) && !SHIELDSTRAL_PAIRED_RULES.includes(k as never) && !neverFromQwen.includes(k)
		);
		expect(unaccounted).toEqual([]);
	});
	it("gives every rule its own query, so a query names one rule", () => {
		const queries = loadGuardPolicy()!.entries.map((r) => r.query);
		expect(new Set(queries).size).toBe(queries.length);
	});
});

describe("one call per unit", () => {
	afterEach(() => vi.unstubAllGlobals());
	const ctx = () => ({ instruct: "x", opSignal: new AbortController().signal, timeoutMs: 5000, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
	const reply = (content: string, status = 200) =>
		vi.fn(async () => new Response(JSON.stringify({ model: QWEN3GUARD_MODEL, choices: [{ message: { content } }] }), { status }));

	it("asks Qwen3Guard once for all of a unit's rules, and again for another unit", async () => {
		const f = reply("Safety: Unsafe\nCategories: Violent");
		const judge = makeQwen3GuardJudge({ endpoint: "http://q/v1/chat/completions", fetchImpl: f as never });
		const unit = { kind: "text" as const, text: "a" };
		const answers = await Promise.all(
			loadGuardPolicy()!.entries.map((r) => judge(unit, r.query, 0.5, ctx()).then((o) => [r.key, o.answer] as const))
		);
		expect(f).toHaveBeenCalledTimes(1);
		expect(answers.filter(([, a]) => a.kind === "token" && a.yes).map(([k]) => k)).toEqual(["chat-block-violence"]);
		await judge({ kind: "text", text: "b" }, loadGuardPolicy()!.entries[0].query, 0.5, ctx());
		expect(f).toHaveBeenCalledTimes(2);
	});

	it("sends the unit's text as the one user message and reports the served model", async () => {
		const f = reply("Safety: Safe\nCategories: None");
		const judge = makeQwen3GuardJudge({ endpoint: "http://q/v1/chat/completions", fetchImpl: f as never });
		const o = await judge({ kind: "text", text: "hello" }, loadGuardPolicy()!.entries[0].query, 0.5, ctx());
		const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
		expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
		expect(body.model).toBe(QWEN3GUARD_MODEL);
		expect(o).toMatchObject({ answer: { kind: "token", yes: false }, httpOk: true, servedModel: QWEN3GUARD_MODEL });
	});

	it("answers unknown, never a pass, for a non-2xx, an unreadable reply and a picture", async () => {
		const q = loadGuardPolicy()!.entries[0].query;
		const down = makeQwen3GuardJudge({ endpoint: "http://q/x", fetchImpl: reply("", 503) as never });
		expect(await down({ kind: "text", text: "a" }, q, 0.5, ctx())).toMatchObject({ answer: { kind: "unknown" }, httpOk: false });
		const garbled = makeQwen3GuardJudge({ endpoint: "http://q/x", fetchImpl: reply("I cannot help") as never });
		expect(await garbled({ kind: "text", text: "a" }, q, 0.5, ctx())).toMatchObject({ answer: { kind: "unknown" }, httpOk: true });
		const f = reply("Safety: Safe");
		const judge = makeQwen3GuardJudge({ endpoint: "http://q/x", fetchImpl: f as never });
		expect((await judge({ kind: "image", image: {} as never }, q, 0.5, ctx())).answer).toEqual({ kind: "unknown" });
		expect(f).not.toHaveBeenCalled();
	});

	it("starts no request after the operation deadline", async () => {
		const f = reply("Safety: Safe");
		const judge = makeQwen3GuardJudge({ endpoint: "http://q/x", fetchImpl: f as never });
		const ac = new AbortController();
		ac.abort();
		const o = await judge({ kind: "text", text: "a" }, loadGuardPolicy()!.entries[0].query, 0.5, { ...ctx(), opSignal: ac.signal });
		expect(o.answer).toEqual({ kind: "unknown" });
		expect(f).not.toHaveBeenCalled();
	});
});
