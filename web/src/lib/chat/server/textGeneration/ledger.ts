// Math routing's ledger, as data: the typed-lines schema the turn planner's math field is built from
// (turnPlan.ts), and the code that validates, sums and renders what comes back. Kept free of imports so
// a script can load the exact schema the app sends (web/scripts/math-trigger-bench.mjs) instead of a
// copy that drifts from it.

const LEDGER_TOOL_NAME = "record_ledger";
const MAX_LINES = 40;

export const LEDGER_TOOL = {
	type: "function" as const,
	function: {
		name: LEDGER_TOOL_NAME,
		description:
			"Record every group of items the question counts, as one line per group. Code multiplies each " +
			"line and adds the lines up; you never state a total.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["asks_for_calculation", "lines"],
			properties: {
				// First, so the model decides it before it writes lines. Without it the schema's only
				// answer is one or more lines, and a summary request that merely contains figures comes
				// back as a ledger of them (CUR-2161).
				asks_for_calculation: {
					type: "boolean",
					description:
						"True only when the latest message asks for a number to be worked out (a total, a count, " +
						"a difference, a cost). False when it asks for anything else, such as a summary, rewrite, " +
						"translation or explanation, even if the text contains figures.",
				},
				lines: {
					type: "array",
					minItems: 0,
					maxItems: MAX_LINES,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["factors", "label"],
						properties: {
							factors: {
								type: "array",
								minItems: 1,
								maxItems: 6,
								items: { type: "number" },
								description:
									"The numbers this line multiplies together, e.g. [3, 14, 18] for 3 workshops of 14 people at 18 each. Make the first factor negative for something taken away, lost or subtracted.",
							},
							label: { type: "string", maxLength: 80, description: "A short name for the group." },
						},
					},
				},
				unit: { type: "string", maxLength: 24, description: "The unit of the total, if any (EUR, FTE, eggs)." },
			},
		},
	},
};

type LedgerLine = { factors: number[]; label: string };
export type Ledger = { lines: LedgerLine[]; unit?: string };

/** Validates the tool arguments. The schema already constrains the shape where the host honours it;
 *  this is the check for a host that does not, and for what JSON Schema cannot say (finite numbers). */
export function parseLedgerArgs(raw: string | undefined): Ledger | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const lines = (parsed as { lines?: unknown })?.lines;
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) return null;
	const out: LedgerLine[] = [];
	for (const l of lines) {
		// typeof, not Number(): JSON has no Infinity, so an overflowing number arrives as null, and
		// Number(null) is 0 — a line silently dropped from the sum.
		const factors = (l as Partial<LedgerLine> | null)?.factors;
		if (!Array.isArray(factors) || factors.length === 0 || factors.length > 6) return null;
		if (!factors.every((f) => typeof f === "number" && Number.isFinite(f))) return null;
		const label = String((l as LedgerLine)?.label ?? "").trim().slice(0, 80);
		out.push({ factors: factors as number[], label });
	}
	const unitRaw = (parsed as { unit?: unknown }).unit;
	const unit = typeof unitRaw === "string" && unitRaw.trim() ? unitRaw.trim().slice(0, 24) : undefined;
	return { lines: out, ...(unit ? { unit } : {}) };
}

// The rows and total renderLedger wrote before CUR-3663, stamp included, as they come back in an answer
// persisted then. The stamp is what kept this from matching model prose; a ledger rendered since has no
// stamp and is read from the message's `mathLedger` field instead (planTranscript).
export const RENDERED_LEDGER_RE =
	// The unit runs up to the stamp: renderLedger wrote any unit of up to 24 characters, spaces included
	// ("intact eggs"), and a one-word match skipped the whole ledger (CUR-2236).
	/((?:^- [^\n]*: -?[\d.,]+(?: × -?[\d.,]+)* = -?[\d.,]+\n)+)\nTotal: \*\*(-?[\d.,]+)\*\*(?: ([^\n]{1,24}?))? _\(arithmetic checked by code\)_\n*/gm;
export const RENDERED_ROW_RE = /^- ([^\n]*): (-?[\d.,]+(?: × -?[\d.,]+)*) = -?[\d.,]+$/gm;

/** Rewrites this module's own rendered ledger in an earlier assistant message as one compact line.
 *  A forced ledger call can come back as text in the rendered-row format instead of a tool call when the
 *  transcript shows the model that format as what an answer looks like. This parses
 *  only text this module wrote, never model prose. */
export function compactRenderedLedgers(text: string): string {
	return text.replace(RENDERED_LEDGER_RE, (_m, rows: string, total: string, unit?: string) => {
		const items = [...rows.matchAll(RENDERED_ROW_RE)].map(([, label, factors]) => `${factors} ${label}`);
		return `(Earlier checked ledger: ${items.join("; ")}; total ${total}${unit ? ` ${unit}` : ""}.)\n\n`;
	});
}

/** The label renderLedger no longer puts on a total (CUR-3663): it vouched for sums whose setup was
 *  wrong. Answers persisted earlier still carry it and models copy it from them, so
 *  `stripForgedStamp` removes it from model prose (CUR-2199). */
export const LEDGER_STAMP = "_(arithmetic checked by code)_";

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

function lineValue(l: LedgerLine): number {
	return l.factors.reduce((product, f) => product * f, 1);
}

export function ledgerTotal(ledger: Ledger): number {
	return round(ledger.lines.reduce((sum, l) => sum + lineValue(l), 0));
}

function fmt(n: number): string {
	return round(n).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

// ISO 4217 codes the runtime knows, plus the symbols the ledger's `unit` arrives as instead.
const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const CURRENCY_SYMBOLS = new Set(["$", "€", "£", "¥", "₹", "₩", "₽", "₺", "₪", "₫", "₱", "₦", "฿"]);

function isCurrency(unit: string | undefined): boolean {
	if (!unit) return false;
	// Exact case: "cup" in a recipe is not the Cuban peso's CUP.
	return CURRENCY_SYMBOLS.has(unit) || CURRENCY_CODES.has(unit);
}

/** A total in money reads in cents, as a receipt shows it: "$59.699875" is what a visitor saw (CUR-2206).
 *  The rows keep their precision, since they are the working. */
function fmtTotal(ledger: Ledger): string {
	const total = ledgerTotal(ledger);
	if (!isCurrency(ledger.unit)) return fmt(total);
	return total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A clock-time ledger sums to minutes from midnight (the planner's own unit string, from its
// example in turnPlan.ts), and an answer model that converts that sum back to a time itself gets it
// wrong (told 780, it can write 12:40 or 10:00 instead of 13:00). Code does the conversion. (CUR-2381)
const CLOCK_UNIT = "minutes from midnight";
const DAY_MINUTES = 24 * 60;

/** The total as a 24-hour clock time when the ledger counts minutes from midnight, else null. */
export function ledgerClockTime(ledger: Ledger): string | null {
	if (ledger.unit?.toLowerCase() !== CLOCK_UNIT) return null;
	const total = ledgerTotal(ledger);
	if (!Number.isInteger(total) || total < 0) return null;
	const days = Math.floor(total / DAY_MINUTES);
	const minutes = total % DAY_MINUTES;
	const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
	if (days === 0) return hhmm;
	return `${hhmm} ${days === 1 ? "the next day" : `${days} days later`}`;
}

/** The rows and total the reader sees, rendered by code. Same wording as the fence fallback's, so a
 *  reader (and the bake-off harness) sees one format whichever path answered. */
export function renderLedger(ledger: Ledger): string {
	const unit = ledger.unit ? ` ${ledger.unit}` : "";
	const rows = ledger.lines.map(
		(l) => `- ${l.label || "item"}: ${l.factors.map(fmt).join(" × ")} = ${fmt(lineValue(l))}`
	);
	const clock = ledgerClockTime(ledger);
	return `${rows.join("\n")}\n\nTotal: **${fmtTotal(ledger)}**${unit}${clock ? `\nClock time: **${clock}**` : ""}`;
}

function clockNote(ledger: Ledger): string {
	const clock = ledgerClockTime(ledger);
	return clock ? `That total is the clock time ${clock}; state the time as ${clock} and do not convert it yourself. ` : "";
}

/** What the answer model is told. The ledger is already on screen above its reply. The wording targets
 *  a failure where the answer model reads the rows as the state BEFORE the latest change and
 *  applies the change again in prose ("adding one more would bring you to
 *  13.5" under a checked 12.5 that already included that person). */
export function ledgerAnswerNote(ledger: Ledger): string {
	return (
		"The arithmetic for this turn has been done by code and is already shown to the reader directly " +
		`above your reply:\n\n${renderLedger(ledger)}\n\n` +
		"Those rows are the state AFTER the change the latest message describes: that change is already " +
		"applied, so do not apply it again. Do not repeat the list and do not redo " +
		"any arithmetic. Answer in a few sentences of plain words. Do not state any count, amount or total " +
		`that is not in the rows above; the total is exactly ${fmtTotal(ledger)}. ` +
		clockNote(ledger) +
		"If the rows seem " +
		"to misread the conversation, say which group looks wrong instead of giving a different number. " +
		"If you explain how the total is made up, name only the rows above with their own figures; never " +
		"split it into parts the rows do not show."
	);
}
