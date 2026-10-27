import { describe, it, expect } from "vitest";
import pino from "pino";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { buildLoggerOptions } from "./loggerOptions";
import { runWithRequestContext } from "./requestContext";
import { createHash } from "node:crypto";

// CUR-1721. Every assertion reads the SERIALIZED line from a real pino built with the production
// options, because that line is what both Axiom datasets receive. A sentinel stands in for what a
// user typed; if it appears anywhere in the line, the content reached the log.
// Written out here rather than imported, so a field dropped from logRedaction.ts goes red.
const CONTENT_FIELDS = ["q", "query", "question", "prompt", "content", "text", "answer", "messages", "reasoning", "rawArgs", "body"];
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

	it("leaves operational fields alone, so the queries that read them keep matching", () => {
		const [line] = capture((logger) =>
			logger.info({ qLength: 42, model: "mistral-large-2512", ms: 812, ok: true }, "[rag] timing")
		);
		expect(JSON.parse(line)).toMatchObject({ qLength: 42, model: "mistral-large-2512", ms: 812, ok: true });
	});
});
