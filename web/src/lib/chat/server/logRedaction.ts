// What a server log line is allowed to say about a user's content, applied to every line at the
// pino layer.
//
// Both Axiom datasets read the same bytes: the Vercel drain reads stdout and axiomStream.ts posts a
// copy, so a redaction in either sink alone leaves the other one carrying the content. Axiom keeps
// what it receives for the dataset's full retention, and deleting an account does not reach it.
//
// A `[persist] failed to save conversation` line can carry the whole conversation document in
// `err.params` (tens of thousands of characters), because drizzle's
// DrizzleQueryError keeps the bound values on `params` AND interpolates them into `message` (and so
// into `stack`). Field names like `q` and `reasoning` can carry question text and model output too.
//
// Same convention as agent-service/api/logsink.py: content becomes `<redacted:N>`, so a line still
// says that something was there and how big it was, and `user` becomes `u_` plus a short hash, which
// keeps "how many lines for this user" answerable without the name.
import { createHash } from "node:crypto";
import pino from "pino";

/** Top-level fields whose values can quote what a user wrote, or what a model wrote back. */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
	"q",
	"query",
	"question",
	"prompt",
	"content",
	"text",
	"answer",
	"messages",
	"reasoning",
	"rawArgs",
	"body",
	// Model output and its pieces, tool arguments, and names a person chose for a chat or a file.
	"output",
	"completion",
	"delta",
	"args",
	"title",
	"snippet",
	"filename",
	"relPath",
]);

/**
 * How deep the redaction follows nested objects and arrays. A content field one level down
 * (`{ turn: { text } }`) is as much a leak as one at the top; past this depth the value is replaced
 * whole, so an unexpectedly deep object cannot carry content below the walk.
 */
const MAX_DEPTH = 4;

/** A field named `url`, `targetUrl`, `redirectURL`… holds an address whose query or fragment can carry
 *  what a person typed (`?q=`, `?path=`, `?url=`). The origin and path stay; the rest is cut. */
const URL_KEY = /(^url|Url|URL)$/;

/** Top-level fields that identify a person or a device directly. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set(["ip", "email"]);

function redactedMarker(value: unknown): string {
	if (typeof value === "string" || Array.isArray(value)) return `<redacted:${value.length}>`;
	try {
		return `<redacted:${(JSON.stringify(value ?? "") ?? "").length}>`;
	} catch {
		// A circular or BigInt-holding value: the size is unknown, the content still never leaves.
		return "<redacted>";
	}
}

function hashUser(user: string): string {
	return "u_" + createHash("sha256").update(user).digest("hex").slice(0, 12);
}

function isEmpty(v: unknown): boolean {
	return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function stripUrlQuery(v: string): string {
	const cut = v.search(/[?#]/);
	if (cut < 0) return v;
	return `${v.slice(0, cut)}?<redacted:${v.length - cut - 1}>`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object") return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/** One field's value after redaction, by its key; returns the value itself when nothing changes. */
function redactField(k: string, v: unknown, depth: number): unknown {
	if (isEmpty(v)) return v;
	if (CONTENT_FIELDS.has(k)) return redactedMarker(v);
	if (IDENTITY_FIELDS.has(k)) return "<redacted>";
	if (k === "user" && typeof v === "string" && !v.startsWith("u_")) return hashUser(v);
	if (typeof v === "string") return URL_KEY.test(k) ? stripUrlQuery(v) : v;
	// A top-level `err` or `error` reaches the serializer below; an Error anywhere else would be
	// written with its enumerable fields, which for a drizzle error are the bound values.
	if (v instanceof Error) return depth === 0 && (k === "err" || k === "error") ? v : redactingErrSerializer(v);
	if (Array.isArray(v) || isPlainObject(v)) {
		if (depth >= MAX_DEPTH) return redactedMarker(v);
		return redactNested(v, depth + 1);
	}
	return v;
}

function redactNested(v: unknown[] | Record<string, unknown>, depth: number): unknown {
	if (Array.isArray(v)) {
		let out: unknown[] | undefined;
		v.forEach((item, i) => {
			const r = Array.isArray(item) || isPlainObject(item) ? redactField("", item, depth) : item;
			if (r !== item) (out ??= [...v])[i] = r;
		});
		return out ?? v;
	}
	let out: Record<string, unknown> | undefined;
	for (const [k, item] of Object.entries(v)) {
		const r = redactField(k, item, depth);
		if (r !== item) (out ??= { ...v })[k] = r;
	}
	return out ?? v;
}

/** pino `formatters.log`: runs after the mixin is merged, so it sees request-context `user` too. */
export function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
	return redactNested(obj, 0) as Record<string, unknown>;
}

// drizzle writes `Failed query: <sql>\nparams: <values>`; the stack repeats the message before its
// first frame. Keep the SQL (it is ours and names the table) and cut the values.
const PARAMS_TAIL = /\nparams: [\s\S]*?(?=\n {4}at |$)/;

// V8 quotes the start of the text it could not parse: `Unexpected token 'm', "my landlor"... is not
// valid JSON`. That text is often a model's output or tool arguments.
const JSON_SNIPPET = /, (?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON/g;

// Postgres repeats the offending values in `detail`: `Key (email)=(…) already exists.` and
// `Failing row contains (…)`, the second one the whole row.
const PG_KEY_VALUES = /(Key \([^)]*\)=)\(([\s\S]*?)\)(?= |$)/g;
const PG_FAILING_ROW = /(Failing row contains )\(([\s\S]*)\)/;

/** An error's text with the user content it can quote cut out; non-strings pass through. */
function stripErrorText(s: unknown): unknown {
	if (typeof s !== "string") return s;
	let out = s;
	const m = PARAMS_TAIL.exec(out);
	if (m) out = out.slice(0, m.index) + `\nparams: <redacted:${m[0].length - "\nparams: ".length}>` + out.slice(m.index + m[0].length);
	out = out.replace(JSON_SNIPPET, (whole) => `, <redacted:${whole.length - ", ".length - " is not valid JSON".length}> is not valid JSON`);
	out = out.replace(PG_KEY_VALUES, (_w, head: string, vals: string) => `${head}<redacted:${vals.length}>`);
	out = out.replace(PG_FAILING_ROW, (_w, head: string, row: string) => `${head}<redacted:${row.length}>`);
	return out;
}

type SerializedErr = Record<string, unknown> & { cause?: unknown };

function redactSerializedErr(e: SerializedErr, depth = 0): SerializedErr {
	if (!e || typeof e !== "object" || depth > 4) return e;
	const out: SerializedErr = { ...e };
	if (!isEmpty(out.params)) out.params = redactedMarker(out.params);
	out.message = stripErrorText(out.message);
	out.stack = stripErrorText(out.stack);
	if (typeof out.detail === "string") out.detail = stripErrorText(out.detail);
	if (out.cause && typeof out.cause === "object") out.cause = redactSerializedErr(out.cause as SerializedErr, depth + 1);
	return out;
}

/** pino serializer for `err` and `error`: the standard Error serializer, then the redaction. */
export function redactingErrSerializer(err: unknown): unknown {
	// `{ err: e.message }` hands the serializer a string, which can quote the same content.
	if (typeof err === "string") return stripErrorText(err);
	if (!(err instanceof Error)) return err;
	return redactSerializedErr(pino.stdSerializers.err(err) as unknown as SerializedErr);
}

/**
 * pino `hooks.logMethod`. `logger.error(err)` with no message of its own makes pino copy
 * `err.message` onto the line's `message`, which no serializer sees; hand it the stripped one.
 * A message string the caller wrote is not touched here: content interpolated into it
 * (`logger.warn(\`… ${text}\`)`) is past any redaction, so put content in a field instead.
 */
export function redactBareErrorMessage(
	this: pino.Logger,
	args: Parameters<pino.LogFn>,
	method: pino.LogFn
): void {
	const [first, second] = args as unknown[];
	if (first instanceof Error && typeof second !== "string") {
		const msg = stripErrorText(first.message);
		if (msg !== first.message) return method.apply(this, [first, msg as string]);
	}
	return method.apply(this, args);
}
