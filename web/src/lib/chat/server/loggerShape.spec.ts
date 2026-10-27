import { describe, it, expect } from "vitest";
import pino from "pino";
import { buildLoggerOptions } from "./loggerOptions";
import { runWithRequestContext } from "./requestContext";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

// Pins the JSON shape of a production log line against the queries that read it — scripts/
// axiom-alert.mjs:52 (the http-5xx alert, which parses `message` and reads a flat `status_code`),
// the observability notes, and the saved Axiom queries behind it.
//
// This is a DEPENDENCY tripwire, not a test of our own logic — the logic here is four `if`s. It earns
// its place because a pino major can change the emitted shape without changing a line of our code,
// and the resulting failure is invisible: the app runs, the lines arrive, and log search silently
// stops matching. A 5xx alert that reports zero cannot be told from a healthy service. Every
// assertion below names the query property it protects, so a red says which query just broke rather
// than "shape changed".
//
// Deliberately asserts on the SERIALIZED line rather than on the options object, because the options
// are only a request — pino decides what actually comes out.

/** Build a logger from the real options and return the lines it emitted, parsed. */
function capture(
	level: string,
	emit: (logger: pino.Logger) => void
): Record<string, unknown>[] {
	const lines: string[] = [];
	const stream: pino.DestinationStream = {
		write: (line: string) => {
			lines.push(line);
		},
	};
	emit(pino(buildLoggerOptions({ dev: false, level }), stream));
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("production log line shape", () => {
	it("carries the log text under `message`, never under pino's default `msg`", () => {
		const [line] = capture("info", (logger) => logger.info("moderation gate declined a turn"));
		expect(line.message).toBe("moderation gate declined a turn");
		expect(line).not.toHaveProperty("msg");
	});

	it("writes `level` as the lowercase label, not pino's numeric level", () => {
		const lines = capture("debug", (logger) => {
			logger.warn("a warning");
			logger.error("an error");
			logger.info("some info");
		});
		expect(lines.map((l) => l.level)).toEqual(["warn", "error", "info"]);
	});

	it("keeps `time` a number (epoch millis), which is what timestamp correlation parses", () => {
		const before = Date.now();
		const [line] = capture("info", (logger) => logger.info("hi"));
		expect(typeof line.time).toBe("number");
		expect(line.time as number).toBeGreaterThanOrEqual(before);
	});

	it("flattens the request context onto top-level snake_case keys", () => {
		const [line] = capture("info", (logger) =>
			runWithRequestContext(() => logger.info("served"), {
				requestId: "req-abc",
				url: "/chat/conversation/1",
				user: "u-42",
				statusCode: 200,
			})
		);
		expect(line).toMatchObject({
			request_id: "req-abc",
			url: "/chat/conversation/1",
			// Hashed on the way out (CUR-1721, logRedaction.ts); still one stable value per user.
			user: "u_" + createHash("sha256").update("u-42").digest("hex").slice(0, 12),
			status_code: 200,
		});
	});

	it("never carries a client IP — the context has no slot for one, so it cannot reach Axiom", () => {
		const [line] = capture("info", (logger) =>
			runWithRequestContext(() => logger.info("served"), {
				requestId: "req-abc",
				// Deliberately smuggled past the type: a future `ip` field on the context must not be
				// enough to get it onto the line.
				...({ ip: "203.0.113.7" } as object),
			})
		);
		expect(line).not.toHaveProperty("ip");
	});

	it("omits absent context keys rather than emitting them as null", () => {
		const [line] = capture("info", (logger) =>
			runWithRequestContext(() => logger.info("served"), { requestId: "req-abc" })
		);
		expect(line.request_id).toBe("req-abc");
		for (const key of ["url", "user", "status_code"]) {
			expect(line).not.toHaveProperty(key);
		}
	});

	it("stamps the deployment environment as `env` on every line, inside a request and out (CUR-2057)", () => {
		const lines: string[] = [];
		const stream: pino.DestinationStream = { write: (line: string) => void lines.push(line) };
		const logger = pino(buildLoggerOptions({ dev: false, level: "info", env: "preview" }), stream);
		logger.info("boot");
		runWithRequestContext(() => logger.info("served"), { requestId: "req-abc" });
		const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(parsed.map((l) => l.env)).toEqual(["preview", "preview"]);
		expect(parsed[1].request_id).toBe("req-abc");
	});

	it("omits `env` rather than sending it as null when none is known", () => {
		const [line] = capture("info", (logger) => logger.info("boot"));
		expect(line).not.toHaveProperty("env");
	});

	it("stamps the commit and branch on every line, inside a request and out, so develop's lines are findable (CUR-2019)", () => {
		const lines: string[] = [];
		const stream: pino.DestinationStream = { write: (line: string) => void lines.push(line) };
		const sha = "02d7775da4fcb7e18b2503793338bea4a9c6e704";
		const logger = pino(
			buildLoggerOptions({ dev: false, level: "info", env: "preview", commit: sha, branch: "develop" }),
			stream
		);
		logger.info("warm");
		runWithRequestContext(() => logger.info("served"), { requestId: "req-abc" });
		const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(parsed.map((l) => [l.commit, l.branch])).toEqual([
			[sha, "develop"],
			[sha, "develop"],
		]);
	});

	it("stamps the instance on every line, inside a request and out, so mozfest's lines are findable apart from www's (CUR-3202)", () => {
		const lines: string[] = [];
		const stream: pino.DestinationStream = { write: (line: string) => void lines.push(line) };
		const logger = pino(
			buildLoggerOptions({ dev: false, level: "info", env: "production", branch: "main", instance: "mozfest" }),
			stream
		);
		logger.info("warm");
		runWithRequestContext(() => logger.info("served"), { requestId: "req-abc" });
		expect(lines.map((l) => (JSON.parse(l) as Record<string, unknown>).instance)).toEqual(["mozfest", "mozfest"]);
	});

	it("omits `commit` and `branch` rather than sending them as null when none is known", () => {
		const [line] = capture("info", (logger) => logger.info("boot"));
		expect(line).not.toHaveProperty("commit");
		expect(line).not.toHaveProperty("branch");
		expect(line).not.toHaveProperty("instance");
	});

	it("emits no context keys at all outside a request", () => {
		const [line] = capture("info", (logger) => logger.info("boot"));
		expect(line).not.toHaveProperty("request_id");
	});

	it("honours the configured level — a debug call under `info` emits nothing", () => {
		expect(capture("info", (logger) => logger.debug("noisy"))).toHaveLength(0);
		expect(capture("debug", (logger) => logger.debug("noisy"))).toHaveLength(1);
	});

	it("merges structured fields alongside the message instead of nesting them", () => {
		const [line] = capture("info", (logger) =>
			logger.info({ leg: "model", ok: true, latency_ms: 512 }, "warm probe")
		);
		expect(line).toMatchObject({ leg: "model", ok: true, latency_ms: 512, message: "warm probe" });
	});
});

describe("transport", () => {
	// A transport in production would replace the JSON object with pino-pretty's colorized text and
	// break every query at once. Asserted on the options because there is nothing to serialize: the
	// point is that pino is never handed a transport outside dev.
	it("is absent in production", () => {
		expect(buildLoggerOptions({ dev: false, level: "info" }).transport).toBeUndefined();
	});

	// A bare "pino-pretty" leaves pino to resolve it from its callers, and under vite pino
	// 10.4.0 finds no caller that can see it. (CUR-3977)
	it("is pino-pretty in dev, named by an absolute path so pino never resolves it from its callers", () => {
		const target = (buildLoggerOptions({ dev: true, level: "info" }).transport as { target: string }).target;
		expect(isAbsolute(target), `"${target}" is not an absolute path`).toBe(true);
		expect(existsSync(target)).toBe(true);
		expect(target).toMatch(/[\\/]pino-pretty[\\/]/);
	});
});
