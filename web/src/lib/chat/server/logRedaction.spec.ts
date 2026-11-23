import { describe, it, expect } from "vitest";
import pino from "pino";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { buildLoggerOptions } from "./loggerOptions";
import { runWithRequestContext } from "./requestContext";
import { createHash } from "node:crypto";

// Every assertion reads the SERIALIZED line from a real pino built with the production
// options, because that line is what both Axiom datasets receive. A sentinel stands in for what a
// user typed; if it appears anywhere in the line, the content reached the log.
// Written out here rather than imported, so a field dropped from logRedaction.ts goes red.
const CONTENT_FIELDS = [
	"q", "query", "question", "prompt", "content", "text", "answer", "messages", "reasoning", "rawArgs", "body",
	"output", "completion", "delta", "args", "title", "snippet", "filename", "relPath",
];
const hashUser = (u: string) => "u_" + createHash("sha256").update(u).digest("hex").slice(0, 12);
const SENTINEL = "my landlord at 14 Elm Street kept my deposit";

function capture(emit: (logger: pino.Logger) => void): string[] {
	const lines: string[] = [];
	const stream: pino.DestinationStream = { write: (line: string) => void lines.push(line) };
	emit(pino(buildLoggerOptions({ dev: false, level: "info" }), stream));
	return lines;
}

describe("server log lines never carry a user's message body", () => {
	it.each(CONTENT_FIELDS)("redacts `%s` to a length marker", (field) => {
		const [line] = capture((logger) => logger.info({ [field]: SENTINEL }, "a turn"));
		expect(line).not.toContain(SENTINEL);
		expect(JSON.parse(line)[field]).toBe(`<redacted:${SENTINEL.length}>`);
	});

	it("cuts the bound values out of a failed drizzle query: params, message and stack", () => {
		const doc = JSON.stringify({ messages: [{ from: "user", content: SENTINEL }] });
		const err = new DrizzleQueryError('update "conversations" set "doc" = $1 where "id" = $2', [doc, "c-1"]);
		const [line] = capture((logger) => logger.error({ err }, "[persist] failed to save conversation"));

		expect(line).not.toContain(SENTINEL);
		const parsed = JSON.parse(line);
		expect(parsed.err.params).toMatch(/^<redacted:\d+>$/);
		// The SQL is ours and names the table, so it stays.
		expect(parsed.err.message).toContain('update "conversations" set "doc"');
		expect(parsed.err.message).toMatch(/\nparams: <redacted:\d+>$/);
		expect(parsed.err.stack).toContain("\n    at ");
	});

	it("redacts the same error when it is logged under `error` or as the bare argument", () => {
		const err = new DrizzleQueryError("insert into t values ($1)", [SENTINEL]);
		const lines = capture((logger) => {
			logger.error({ error: err }, "under error");
			logger.error(err);
		});
		for (const line of lines) expect(line).not.toContain(SENTINEL);
	});

	it("reaches a drizzle error wrapped as another error's cause", () => {
		const inner = new DrizzleQueryError("insert into t values ($1)", [SENTINEL]);
		const outer = new Error("turn failed", { cause: inner });
		const [line] = capture((logger) => logger.error({ err: outer }, "wrapped"));
		expect(line).not.toContain(SENTINEL);
	});

	it("hashes the request-context user, so lines still group by user without naming one", () => {
		const [line] = capture((logger) =>
			runWithRequestContext(() => logger.info("served"), { requestId: "r", user: "someone@example.org" })
		);
		expect(line).not.toContain("someone@example.org");
		expect(JSON.parse(line).user).toBe(hashUser("someone@example.org"));
	});

	it("drops an `ip` or `email` field to a bare marker", () => {
		const [line] = capture((logger) => logger.info({ ip: "203.0.113.7", email: "a@b.example" }, "x"));
		expect(line).not.toContain("203.0.113.7");
		expect(line).not.toContain("a@b.example");
	});

	it.each([
		["one level down", { turn: { text: SENTINEL } }],
		["inside an array", { turns: [{ role: "user", content: SENTINEL }] }],
		["three levels down", { a: { b: { c: { completion: SENTINEL } } } }],
		["below the walk's depth", { a: { b: { c: { d: { e: { f: SENTINEL } } } } } }],
	])("redacts a content field nested %s", (_where, fields) => {
		const [line] = capture((logger) => logger.info(fields, "a turn"));
		expect(line).not.toContain(SENTINEL);
	});

	it("keeps a nested operational field and its shape", () => {
		const [line] = capture((logger) => logger.info({ timing: { ms: 812, model: "m" }, text: SENTINEL }, "x"));
		expect(JSON.parse(line).timing).toEqual({ ms: 812, model: "m" });
	});

	it("cuts the query string from any url field, keeping origin and path", () => {
		const q = encodeURIComponent(SENTINEL);
		const [line] = capture((logger) =>
			logger.error(
				{
					url: `https://chat.example/chat/api/search?q=${q}`,
					targetUrl: `https://news.example/a?ref=${q}#${q}`,
					nested: { redirectURL: `https://x.example/?s=${q}` },
				},
				"failed"
			)
		);
		expect(line).not.toContain(q);
		expect(line).not.toContain(SENTINEL);
		const parsed = JSON.parse(line);
		expect(parsed.url).toMatch(/^https:\/\/chat\.example\/chat\/api\/search\?<redacted:\d+>$/);
		expect(parsed.targetUrl.startsWith("https://news.example/a?<redacted:")).toBe(true);
	});

	it("leaves a url with no query alone (the request context's path)", () => {
		const [line] = capture((logger) => logger.info({ url: "/chat/conversation/abc" }, "x"));
		expect(JSON.parse(line).url).toBe("/chat/conversation/abc");
	});

	it("cuts the text V8 quotes from input it could not parse as JSON", () => {
		let parseErr: unknown;
		try {
			JSON.parse(`${SENTINEL} {`);
		} catch (e) {
			parseErr = e;
		}
		const lines = capture((logger) => {
			logger.warn({ err: parseErr }, "tool args unreadable");
			logger.warn(parseErr as Error);
			logger.warn({ err: (parseErr as Error).message }, "as a string");
		});
		// V8 quotes the first ten characters; the sentinel's opening words are the leak.
		for (const line of lines) expect(line).not.toContain(SENTINEL.slice(0, 10));
		expect(JSON.parse(lines[0]).err.message).toMatch(/<redacted:\d+> is not valid JSON$/);
	});

	it("cuts the values Postgres repeats in an error's detail", () => {
		const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
			detail: "Key (email)=(someone@example.org) already exists.",
		});
		const rowErr = Object.assign(new Error('null value in column "title" violates not-null constraint'), {
			detail: `Failing row contains (c-1, ${SENTINEL}, null).`,
		});
		const lines = capture((logger) => {
			logger.error({ err: pgErr }, "insert failed");
			logger.error({ err: new Error("save failed", { cause: rowErr }) }, "save failed");
		});
		expect(lines[0]).not.toContain("someone@example.org");
		expect(JSON.parse(lines[0]).err.detail).toMatch(/^Key \(email\)=<redacted:\d+> already exists\.$/);
		expect(lines[1]).not.toContain(SENTINEL);
	});

	it("serializes a drizzle error logged under a key other than err or error", () => {
		const err = new DrizzleQueryError("insert into t values ($1)", [SENTINEL]);
		const lines = capture((logger) => {
			logger.error({ cause: err }, "top level, other key");
			logger.error({ failure: { err } }, "nested under err");
		});
		for (const line of lines) expect(line).not.toContain(SENTINEL);
	});

	it("does not throw on a circular object below the walk's depth", () => {
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		expect(() => capture((logger) => logger.info({ a: { b: { c: { d: { loop } } } } }, "x"))).not.toThrow();
	});

	it("leaves operational fields alone, so the queries that read them keep matching", () => {
		const [line] = capture((logger) =>
			logger.info({ qLength: 42, model: "mistral-large-2512", ms: 812, ok: true }, "[rag] timing")
		);
		expect(JSON.parse(line)).toMatchObject({ qLength: 42, model: "mistral-large-2512", ms: 812, ok: true });
	});
});
