import { describe, it, expect } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { AGENT_MODEL_ID } from "$lib/chat/server/chat/resolveAgentRoute";
import {
	compactRenderedLedgers,
	ledgerAnswerNote,
	ledgerPrefixStream,
	ledgerTotal,
	parseLedgerArgs,
	renderLedger,
	namedServedModel,
	plannedMathForcesCalculate,
	plannerSeesTurn,
	plansTurnFor,
	stripForgedStamp,
} from "./mathRouting";
import { CLOCK_TIME_RULE, PLAN_SYSTEM, planSystemFor, planTranscript } from "./turnPlan";
import { LEDGER_STAMP, ledgerClockTime, type Ledger } from "./ledger";

// An answer persisted before CUR-3663, when renderLedger put the label on the total line.
const legacyRender = (l: Ledger) => renderLedger(l).replace(/^(Total: .*)$/m, `$1 ${LEDGER_STAMP}`);
import { parsePlan } from "./turnPlan";

describe("parseLedgerArgs, the check behind the forced ledger call (CUR-2065)", () => {
	it("reads typed lines and an optional unit", () => {
		const ledger = parseLedgerArgs(
			JSON.stringify({
				lines: [
					{ factors: [9, 1], label: "full-time" },
					{ factors: [3, 0.5], label: "part-time at 50 percent" },
				],
				unit: "FTE",
			})
		);
		expect(ledger).toEqual({
			lines: [
				{ factors: [9, 1], label: "full-time" },
				{ factors: [3, 0.5], label: "part-time at 50 percent" },
			],
			unit: "FTE",
		});
	});

	it("returns null (falls back to the fence) rather than a partial ledger when any line is not a finite number", () => {
		expect(parseLedgerArgs(JSON.stringify({ lines: [{ factors: [2, 3], label: "a" }, { factors: ["x", 1], label: "b" }] }))).toBeNull();
		// An overflowing number (1e400 in the model's output) reaches JSON.parse as null.
		expect(parseLedgerArgs('{"lines":[{"factors":[null,1],"label":"a"}]}')).toBeNull();
	});

	it("accepts a three-factor line, so 3 workshops × 14 people × 18 is one row rather than a lost factor", () => {
		const ledger = parseLedgerArgs(
			JSON.stringify({ lines: [{ factors: [3, 14, 18], label: "lunch" }, { factors: [3, 240], label: "room" }] })
		);
		expect(ledger && ledgerTotal(ledger)).toBe(1476);
		expect(ledger && renderLedger(ledger)).toContain("- lunch: 3 × 14 × 18 = 756");
		expect(ledger && compactRenderedLedgers(`${legacyRender(ledger)}\n\nOk.`)).toContain("3 × 14 × 18 lunch");
	});

	it("returns null for an empty ledger, so an answer with no groups is never shown a checked total of 0", () => {
		expect(parseLedgerArgs(JSON.stringify({ lines: [] }))).toBeNull();
		expect(parseLedgerArgs("{}")).toBeNull();
	});

	it("returns null for missing or malformed arguments instead of throwing", () => {
		expect(parseLedgerArgs(undefined)).toBeNull();
		expect(parseLedgerArgs("not json")).toBeNull();
	});
});

describe("renderLedger and ledgerTotal, the arithmetic code does for the model", () => {
	// The label vouched for totals whose setup was wrong, so the rows are the only claim made. (CUR-3663)
	it("sums the FTE sequence to 10.5 and puts no \"checked by code\" label on the total", () => {
		const ledger = { lines: [{ factors: [9, 1], label: "full-time" }, { factors: [3, 0.5], label: "part-time" }] };
		expect(ledgerTotal(ledger)).toBe(10.5);
		expect(renderLedger(ledger)).toBe("- full-time: 9 × 1 = 9\n- part-time: 3 × 0.5 = 1.5\n\nTotal: **10.5**");
	});

	it("subtracts a negative-count line", () => {
		const ledger = { lines: [{ factors: [3, 12], label: "boxes bought" }, { factors: [-1, 12], label: "box that broke" }] };
		expect(ledgerTotal(ledger)).toBe(24);
		expect(renderLedger(ledger)).toContain("- box that broke: -1 × 12 = -12");
	});

	it("does not leak floating-point noise into the total the reader sees", () => {
		const ledger = { lines: [{ factors: [3, 0.1], label: "a" }] };
		expect(renderLedger(ledger)).toContain("Total: **0.3**");
	});

	// The walk's shopping question, as GLM ledgered it on develop. (CUR-2206)
	const shopping = {
		lines: [
			{ factors: [3, 4.75], label: "notebooks" },
			{ factors: [2, 1.2], label: "pens" },
			{ factors: [1, 38.5], label: "backpack" },
			{ factors: [3, 4.75, 0.0825], label: "sales tax on notebooks" },
			{ factors: [2, 1.2, 0.0825], label: "sales tax on pens" },
			{ factors: [1, 38.5, 0.0825], label: "sales tax on backpack" },
		],
		unit: "USD",
	};

	it("shows a money total in cents, never six decimals, in the block and in the note the prose repeats", () => {
		expect(renderLedger(shopping)).toMatch(/Total: \*\*59\.70\*\* USD$/);
		expect(ledgerAnswerNote(shopping)).toContain("the total is exactly 59.70.");
		expect(renderLedger({ ...shopping, unit: "$" })).toContain("Total: **59.70** $");
		expect(renderLedger({ lines: [{ factors: [2, 5400], label: "months" }], unit: "EUR" })).toContain("Total: **10,800.00** EUR");
	});

	it("keeps the decimals of a total that is not money, including a unit that only spells a currency code in other case", () => {
		expect(renderLedger({ ...shopping, unit: undefined })).toContain("Total: **59.699875**");
		expect(renderLedger({ lines: [{ factors: [3, 0.25], label: "flour" }], unit: "cup" })).toContain("Total: **0.75** cup");
		expect(renderLedger({ lines: [{ factors: [1, 2.125], label: "eggs" }], unit: "eggs" })).toContain("Total: **2.125** eggs");
	});

	it("tells the answer model the exact total and not to redo it", () => {
		const note = ledgerAnswerNote({ lines: [{ factors: [2, 5400], label: "months" }] });
		expect(note).toContain("the total is exactly 10,800");
		expect(note).toContain("do not redo any arithmetic");
		expect(note).toContain("Do not state any count, amount or total that is not in the rows above");
	});
});

describe("ledgerPrefixStream", () => {
	async function collect(events: MessageUpdate[]): Promise<MessageUpdate[]> {
		async function* src() {
			yield* events;
		}
		const out: MessageUpdate[] = [];
		for await (const e of ledgerPrefixStream(src(), { lines: [{ factors: [2, 3], label: "pairs" }] })) out.push(e);
		return out;
	}

	it("streams the checked rows before any model token, and keeps them in the persisted final text", async () => {
		const out = await collect([
			{ type: MessageUpdateType.Stream, token: "That makes six." },
			{ type: MessageUpdateType.FinalAnswer, text: "That makes six.", interrupted: false },
		] as MessageUpdate[]);
		expect(out[0]).toEqual({ type: MessageUpdateType.Stream, token: expect.stringContaining("Total: **6**") });
		const final = out.find((e) => e.type === MessageUpdateType.FinalAnswer) as { text: string };
		expect(final.text.startsWith("- pairs: 2 × 3 = 6")).toBe(true);
		expect(final.text).toContain("That makes six.");
	});
});

describe("compactRenderedLedgers", () => {
	it("turns this module's rendered rows into one line, so the extractor is not shown rows to imitate", () => {
		const ledger = { lines: [{ factors: [9, 1], label: "full-time" }, { factors: [3, 0.5], label: "part-time" }], unit: "FTE" };
		const earlier = `${legacyRender(ledger)}\n\nThat is 10.5 FTE.`;
		const out = compactRenderedLedgers(earlier);
		expect(out).toBe("(Earlier checked ledger: 9 × 1 full-time; 3 × 0.5 part-time; total 10.5 FTE.)\n\nThat is 10.5 FTE.");
		expect(out).not.toMatch(/^- /m);
	});

	it("leaves prose without a rendered ledger untouched", () => {
		const text = "- a bullet: not a ledger\n\nTotal: 5 things";
		expect(compactRenderedLedgers(text)).toBe(text);
	});
});

const eggs = { lines: [{ factors: [3, 12], label: "boxes bought" }, { factors: [-1, 12], label: "box that broke" }], unit: "intact eggs" };

// A rendered ledger carries no label, so the text alone cannot tell it from model prose that
// looks the same. The planner reads the ledger the answer stored, and nothing else. (CUR-3663)
describe("planTranscript reads an earlier ledger from the answer's stored mathLedger", () => {
	it("turns the stored ledger into the plan_turn call and result that made it, and keeps the prose after it", () => {
		const out = planTranscript([
			{ from: "user", content: "How many eggs are left?" },
			{ from: "assistant", content: `${renderLedger(eggs)}\n\nYou have 24 intact eggs.`, mathLedger: eggs },
		]);
		const call = out.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls : []))[0];
		expect(call, "the ledger stayed prose").toBeDefined();
		expect(JSON.parse(call.function.arguments).math.lines).toEqual(eggs.lines);
		expect(out.find((m) => m.role === "tool")?.content).toBe("math total: 24 intact eggs");
		expect(out.at(-1)).toEqual({ role: "assistant", content: "You have 24 intact eggs." });
	});

	it("reads model prose shaped exactly like a ledger as prose when the answer stored no ledger", () => {
		const out = planTranscript([{ from: "assistant", content: `${renderLedger(eggs)}\n\nYou have 24 intact eggs.` }]);
		expect(out.some((m) => m.role === "tool")).toBe(false);
	});

	it("reads an answer whose text no longer starts with its stored ledger as prose", () => {
		const out = planTranscript([{ from: "assistant", content: "I can't help with that.", mathLedger: eggs }]);
		expect(out).toEqual([{ role: "assistant", content: "I can't help with that." }]);
	});
});

// renderLedger wrote any unit up to 24 characters, spaces included, and GLM chooses units like
// "intact eggs". A pattern that took one word skipped the whole ledger, so the planner saw it as prose. (CUR-2236)
describe("planTranscript reads back a stamped ledger in an answer persisted before CUR-3663", () => {

	it("turns an earlier ledger whose unit has a space into the plan_turn call and result that made it", () => {
		const out = planTranscript([
			{ from: "user", content: "How many eggs are left?" },
			{ from: "assistant", content: `${legacyRender(eggs)}\n\nYou have 24 intact eggs.` },
			{ from: "user", content: "And if I buy one more box?" },
		]);
		const call = out.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls : []))[0];
		expect(call, "the ledger stayed prose").toBeDefined();
		expect(JSON.parse(call.function.arguments).math.unit).toBe("intact eggs");
		expect(out.find((m) => m.role === "tool")?.content).toBe("math total: 24 intact eggs");
		expect(out.some((m) => typeof m.content === "string" && m.content.includes("checked by code"))).toBe(false);
	});

	it("still reads a one-word unit and a ledger with no unit", () => {
		for (const unit of ["FTE", undefined]) {
			const out = planTranscript([{ from: "assistant", content: legacyRender({ ...eggs, unit }) }]);
			expect(out.find((m) => m.role === "tool")?.content).toBe(`math total: 24${unit ? ` ${unit}` : ""}`);
		}
	});
});

describe("namedServedModel: a ledger turn's badge names the model that wrote it (CUR-2198)", () => {
	async function served(events: MessageUpdate[]): Promise<MessageUpdate[]> {
		async function* src(): AsyncGenerator<MessageUpdate> {
			yield* events;
		}
		const out: MessageUpdate[] = [];
		for await (const e of namedServedModel(src(), "zai-org/GLM-5.2:scaleway")) out.push(e);
		return out;
	}

	it("fills the served model the HF router leaves empty, keeping the provider it reported", async () => {
		const [e] = await served([{ type: MessageUpdateType.RouterMetadata, route: "", model: "", provider: "scaleway" } as MessageUpdate]);
		expect(e).toMatchObject({ model: "zai-org/GLM-5.2:scaleway", provider: "scaleway" });
	});

	it("never overwrites a served model the endpoint did report", async () => {
		const [e] = await served([{ type: MessageUpdateType.RouterMetadata, route: "r", model: "other/model" } as MessageUpdate]);
		expect(e).toMatchObject({ model: "other/model" });
	});
});

describe("stripForgedStamp: only code puts \"checked by code\" on a total (CUR-2199)", () => {
	// Real answers where a stamp from an earlier rendered ledger is copied onto the model's
	// own total, and some of those totals are wrong (15.25 for 15, 16 for 15).
	const forged = [
		"Two left, so the team is now:\n\nTotal: **16** FTE _(arithmetic checked by code)_\n\nThat is one fewer.",
		"Total counted: **14** FTE _(arithmetic checked by code)_",
		"Total: **1,505** EUR _(Arithmetic checked by code)_ for the three workshops.",
		"That comes to 12 ETP (arithmetic checked by code).",
	];

	async function run(tokens: string[], final: string): Promise<{ streamed: string; final: string }> {
		async function* src(): AsyncGenerator<MessageUpdate> {
			for (const token of tokens) yield { type: MessageUpdateType.Stream, token };
			yield { type: MessageUpdateType.FinalAnswer, text: final, interrupted: false } as MessageUpdate;
		}
		let streamed = "";
		let finalText = "";
		for await (const e of stripForgedStamp(src())) {
			if (e.type === MessageUpdateType.Stream) streamed += e.token;
			if (e.type === MessageUpdateType.FinalAnswer) finalText = e.text;
		}
		return { streamed, final: finalText };
	}

	for (const text of forged) {
		it(`never streams or persists the stamp, however the tokens split: ${JSON.stringify(text.slice(0, 40))}`, async () => {
			for (const tokens of [[text], [...text], text.match(/.{1,3}/gs) ?? [], text.split(/(?= )/)]) {
				const out = await run(tokens, text);
				expect(out.streamed).not.toMatch(/checked by code/i);
				expect(out.final).not.toMatch(/checked by code/i);
				expect(out.streamed).toBe(out.final);
			}
		});
	}

	// screenOutputStream persists the answer it rebuilds from Stream tokens, not the FinalAnswer text, so
	// a stamp split around a keepAlive or routerMetadata must not be released in two unmatched halves.
	it("never streams the stamp when a keepAlive or router metadata lands in the middle of it", async () => {
		for (const text of forged) {
			async function* src(): AsyncGenerator<MessageUpdate> {
				for (const token of text.match(/.{1,3}/gs) ?? []) {
					yield { type: MessageUpdateType.Stream, token };
					yield { type: MessageUpdateType.Status, status: "keepAlive" } as MessageUpdate;
					yield { type: MessageUpdateType.RouterMetadata, route: "", model: "m" } as MessageUpdate;
				}
				yield { type: MessageUpdateType.FinalAnswer, text, interrupted: false } as MessageUpdate;
			}
			let streamed = "";
			for await (const e of stripForgedStamp(src())) if (e.type === MessageUpdateType.Stream) streamed += e.token;
			expect(streamed).not.toMatch(/checked by code/i);
		}
	});

	// Output screening releases a sentence at the space after it, so a space held through a pause in the
	// answer keeps that sentence off screen until the model resumes.
	it("releases a sentence's trailing space at the next keepAlive instead of holding it through the pause", async () => {
		const sentence = "Glaciers carve valleys by grinding the rock beneath them. ";
		async function* src(): AsyncGenerator<MessageUpdate> {
			yield { type: MessageUpdateType.Stream, token: sentence };
			yield { type: MessageUpdateType.Status, status: "keepAlive" } as MessageUpdate;
			yield { type: MessageUpdateType.Stream, token: "Over thousands of years." };
			yield { type: MessageUpdateType.FinalAnswer, text: `${sentence}Over thousands of years.`, interrupted: false } as MessageUpdate;
		}
		let beforeResume = "";
		let resumed = false;
		for await (const e of stripForgedStamp(src())) {
			if (e.type === MessageUpdateType.Status) resumed = true;
			else if (e.type === MessageUpdateType.Stream && !resumed) beforeResume += e.token;
		}
		expect(beforeResume).toBe(sentence);
	});

	it("leaves the forged total's own words in place, so only the claim of checking goes", async () => {
		const out = await run([...forged[0]], forged[0]);
		expect(out.final).toBe("Two left, so the team is now:\n\nTotal: **16** FTE\n\nThat is one fewer.");
	});

	it("streams prose that only starts like the stamp, once it stops matching", async () => {
		const text = "Keep a buffer _(about 10%)_ and (arithmetic aside) the plan holds.";
		const out = await run([...text], text);
		expect(out.streamed).toBe(text);
		expect(out.final).toBe(text);
	});

	it("puts the unlabelled code-rendered ledger in front of the answer, with the model's copied label gone", async () => {
		async function* model(): AsyncGenerator<MessageUpdate> {
			yield { type: MessageUpdateType.Stream, token: "Total: **99** _(arithmetic checked by code)_" };
			yield { type: MessageUpdateType.FinalAnswer, text: "Total: **99** _(arithmetic checked by code)_", interrupted: false } as MessageUpdate;
		}
		let final = "";
		for await (const e of ledgerPrefixStream(stripForgedStamp(model()), { lines: [{ factors: [2, 3], label: "pairs" }] }))
			if (e.type === MessageUpdateType.FinalAnswer) final = e.text;
		expect(final).toBe("- pairs: 2 × 3 = 6\n\nTotal: **6**\n\nTotal: **99**");
	});
});

// Large 3 answers its own arithmetic; only a model that cannot call tools is routed. (CUR-2282)
describe("plansTurnFor — which turns get a plan call", () => {
	it("skips a model that can call tools, so Large 3's math turn stays on Large 3", () => {
		expect(plansTurnFor({ supportsTools: true })).toBe(false);
	});

	it("plans for a model that cannot call tools, as Apertus is registered", () => {
		expect(plansTurnFor({ supportsTools: false })).toBe(true);
		expect(plansTurnFor({})).toBe(true);
	});

	// The agent model declares no tool support, so it was planned, and a ledger then handed
	// its turn to the planner's model: Agent on, and Mistral Medium answered with no agent run. (CUR-3884)
	it("skips the agent model, so an agent turn with a number in it still runs the agent", () => {
		expect(plansTurnFor({ id: AGENT_MODEL_ID })).toBe(false);
		expect(plansTurnFor({ id: AGENT_MODEL_ID, supportsTools: false })).toBe(false);
	});
});

// ALIA can call tools but rarely calls calculate unprompted, so its row asks for the plan. (CUR-4191)
describe("plannedMathForcesCalculate — a tool-calling model whose row forces calculate on planned math", () => {
	const alia = { id: "bsc-lt/alia-40b-instruct", supportsTools: true };
	const large3 = { id: "mistral-large-2512", supportsTools: true };

	it("plans ALIA's turn and forces calculate rather than handing it to the route model", () => {
		expect(plansTurnFor(alia)).toBe(true);
		expect(plannedMathForcesCalculate(alia)).toBe(true);
	});

	it("leaves a tool-calling model without the row field unplanned, as Large 3 is", () => {
		expect(plansTurnFor(large3)).toBe(false);
		expect(plannedMathForcesCalculate(large3)).toBe(false);
	});

	it("never forces calculate on a model that cannot call tools, which keeps the ledger handoff", () => {
		expect(plannedMathForcesCalculate({ ...alia, supportsTools: false })).toBe(false);
		expect(plansTurnFor({ ...alia, supportsTools: false })).toBe(true);
	});
});

// The plan transcript is text only, so a plan over an attachment stamped a count it never saw. (CUR-3011)
describe("plannerSeesTurn — no plan over a file the planner is not shown", () => {
	const paste = { type: "application/vnd.chatui.clipboard", name: "Pasted Content" };

	it("withholds the plan when the newest user message carries a file or a paste chip", () => {
		expect(plannerSeesTurn([{ from: "user", content: "How many characters are in what I pasted?", files: [paste] }])).toBe(false);
		expect(
			plannerSeesTurn([
				{ from: "user", content: "Hi" },
				{ from: "assistant", content: "Hello." },
				{ from: "user", content: "What is the total on this receipt?", files: [{ type: "image/jpeg" }] },
			])
		).toBe(false);
	});

	it("plans a text-only turn, including one after an earlier turn's attachment", () => {
		expect(plannerSeesTurn([{ from: "user", content: "What is 12 × 7?" }])).toBe(true);
		expect(plannerSeesTurn([{ from: "user", content: "What is 12 × 7?", files: [] }])).toBe(true);
		expect(
			plannerSeesTurn([
				{ from: "user", content: "Read this.", files: [paste] },
				{ from: "assistant", content: "Done." },
				{ from: "user", content: "What is 12 × 7?" },
			])
		).toBe(true);
	});
});

// Told a total of 780 minutes from midnight, the answer model wrote 13:00 on 3 of 20 preview
// turns and 12:40, 12:20, 12:55 or 10:00 on the rest. Code states the clock time instead. (CUR-2381)
describe("a ledger in minutes from midnight carries its clock time, worked out by code", () => {
	const train = {
		lines: [
			{ factors: [9, 60], label: "09:00 in minutes" },
			{ factors: [40, 1], label: "the 40 minutes of 09:40" },
			{ factors: [2, 60], label: "2 hours trip" },
			{ factors: [55, 1], label: "55 minutes trip" },
			{ factors: [25, 1], label: "delay" },
		],
		unit: "minutes from midnight",
	};

	it("renders 780 minutes from midnight as 13:00 and tells the answer model that exact time", () => {
		expect(ledgerClockTime(train)).toBe("13:00");
		expect(renderLedger(train)).toMatch(/Total: \*\*780\*\* minutes from midnight\nClock time: \*\*13:00\*\*$/);
		expect(ledgerAnswerNote(train)).toContain("the clock time 13:00");
	});

	it("names a time that runs past midnight as the next day, not as hours past 24", () => {
		const late = { ...train, lines: [{ factors: [23, 60], label: "23:00" }, { factors: [90, 1], label: "delay" }] };
		expect(ledgerClockTime(late)).toBe("00:30 the next day");
	});

	it("leaves every other unit, and a negative or fractional total, without a clock line", () => {
		expect(ledgerClockTime({ ...train, unit: "minutes" })).toBeNull();
		expect(ledgerClockTime({ ...train, unit: undefined })).toBeNull();
		expect(ledgerClockTime({ ...train, lines: [{ factors: [-5, 1], label: "x" }] })).toBeNull();
		expect(ledgerClockTime({ ...train, lines: [{ factors: [1.5, 1], label: "x" }] })).toBeNull();
		expect(renderLedger({ ...train, unit: "minutes" })).not.toContain("Clock time");
	});

	it("still reads back an earlier clock-time ledger as the plan_turn call that made it", () => {
		const out = planTranscript([{ from: "assistant", content: `${renderLedger(train)}\n\nIt arrives at 13:00.`, mathLedger: train }]);
		expect(out.find((m) => m.role === "tool")?.content).toBe("math total: 780 minutes from midnight");
	});
});

describe("planSystemFor: only a turn that names a clock time gets the clock rule (CUR-2381)", () => {
	it("adds the rule, before the closing sentences, for a clock time written as 09:40, 21h15 or 9am", () => {
		for (const q of ["A train leaves at 09:40. When does it arrive?", "Le train part à 21h15", "We start at 9am"]) {
			const system = planSystemFor(q);
			expect(system, q).toContain(CLOCK_TIME_RULE);
			expect(system.indexOf(CLOCK_TIME_RULE), q).toBeLessThan(system.indexOf("Every number a line depends on"));
		}
	});

	it("sends every other turn the unchanged prompt, so the FTE case keeps the wording it was measured on", () => {
		for (const q of [
			"My team has 12 people and 3 of them work part time at 50 percent. How many full time equivalents is that?",
			"What is 9.40 times 3?",
			"Mix the two in a 3:2 ratio",
			"",
		]) {
			expect(planSystemFor(q), q).toBe(PLAN_SYSTEM);
		}
	});
});

// "How many cantons does Switzerland have?" must not come back as one line holding one number, and the
// turn must not move off Apertus to the planner's model for a ledger with nothing to add. (CUR-3316)
describe("parsePlan drops a one-number ledger, so a count read off the question stays on the picked model (CUR-3316)", () => {
	it("plans no math for one line holding one number", () => {
		const plan = parsePlan(JSON.stringify({ math: { lines: [{ factors: [26], label: "cantons" }] } }));
		expect(plan?.math).toEqual({ outcome: "nothing-to-compute", ledger: null });
	});

	it("keeps a ledger with something to multiply or add", () => {
		expect(parsePlan(JSON.stringify({ math: { lines: [{ factors: [3, 12], label: "boxes" }] } }))?.math.outcome).toBe("ok");
		const two = parsePlan(
			JSON.stringify({ math: { lines: [{ factors: [26], label: "a" }, { factors: [4], label: "b" }] } })
		);
		expect(two?.math.outcome).toBe("ok");
	});
});
