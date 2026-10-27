// What a server log line is allowed to say about a user's content, applied to every line at the
// pino layer (CUR-1721).
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
]);

/** Top-level fields that identify a person or a device directly. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set(["ip", "email"]);

function redactedMarker(value: unknown): string {
	const n =
		typeof value === "string" || Array.isArray(value)
			? value.length
			: JSON.stringify(value ?? "").length;
	return `<redacted:${n}>`;
}

function hashUser(user: string): string {
	return "u_" + createHash("sha256").update(user).digest("hex").slice(0, 12);
}

function isEmpty(v: unknown): boolean {
	return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** pino `formatters.log`: runs after the mixin is merged, so it sees request-context `user` too. */
export function redactLogObject(obj: Record<string, unknown>): Record<string, unknown> {
	let out: Record<string, unknown> | undefined;
	const set = (k: string, v: unknown) => {
		out ??= { ...obj };
		out[k] = v;
	};
	for (const [k, v] of Object.entries(obj)) {
		if (isEmpty(v)) continue;
		if (CONTENT_FIELDS.has(k)) set(k, redactedMarker(v));
		else if (IDENTITY_FIELDS.has(k)) set(k, "<redacted>");
		else if (k === "user" && typeof v === "string" && !v.startsWith("u_")) set(k, hashUser(v));
	}
	return out ?? obj;
}

// drizzle writes `Failed query: <sql>\nparams: <values>`; the stack repeats the message before its
// first frame. Keep the SQL (it is ours and names the table) and cut the values.
const PARAMS_TAIL = /\nparams: [\s\S]*?(?=\n {4}at |$)/;

function stripParams(s: unknown): unknown {
	if (typeof s !== "string") return s;
	const m = PARAMS_TAIL.exec(s);
	if (!m) return s;
	return s.slice(0, m.index) + `\nparams: <redacted:${m[0].length - "\nparams: ".length}>` + s.slice(m.index + m[0].length);
}

type SerializedErr = Record<string, unknown> & { cause?: unknown };

function redactSerializedErr(e: SerializedErr, depth = 0): SerializedErr {
	if (!e || typeof e !== "object" || depth > 4) return e;
	const out: SerializedErr = { ...e };
	if (!isEmpty(out.params)) out.params = redactedMarker(out.params);
	out.message = stripParams(out.message);
	out.stack = stripParams(out.stack);
	if (out.cause && typeof out.cause === "object") out.cause = redactSerializedErr(out.cause as SerializedErr, depth + 1);
	return out;
}

/** pino serializer for `err` and `error`: the standard Error serializer, then the redaction. */
export function redactingErrSerializer(err: unknown): unknown {
	if (!(err instanceof Error)) return err;
	return redactSerializedErr(pino.stdSerializers.err(err) as unknown as SerializedErr);
}

/**
 * pino `hooks.logMethod`. `logger.error(err)` with no message of its own makes pino copy
 * `err.message` onto the line's `message`, which no serializer sees; hand it the stripped one.
 */
export function redactBareErrorMessage(
	this: pino.Logger,
	args: Parameters<pino.LogFn>,
	method: pino.LogFn
): void {
	const [first, second] = args as unknown[];
	if (first instanceof Error && typeof second !== "string") {
		const msg = stripParams(first.message);
		if (msg !== first.message) return method.apply(this, [first, msg as string]);
	}
	return method.apply(this, args);
}
