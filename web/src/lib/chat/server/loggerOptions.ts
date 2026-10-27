// The pino options that decide the SHAPE of every server log line, extracted from logger.ts so a
// test can hold them to the shape our log queries are written against.
//
// Nothing local goes red when this shape changes. The app keeps running, lines keep arriving, and log
// SEARCH quietly stops matching — which is the worst possible failure for the surface we reach for
// when something else is broken.
//
// The consumer is not hypothetical. scripts/axiom-alert.mjs:52 is the http-5xx alert, and its query is
//   ['vercel'] | extend p = parse_json(message) | extend sc = toint(p['status_code']) | where sc >= 500
// which depends on Vercel's envelope carrying our whole JSON line in `message` AND on `status_code`
// being a flat top-level key inside it. Rename or nest either and that alert reports zero 5xx forever
// — silently, because "no rows" and "no errors" are the same answer. p['level'] takes `info`/`warn`,
// and p['status_code'] and p['request_id'] are present on nearly every record. (The BARE `level` in the
// alert query is Vercel's own envelope field, whose vocabulary is info/warning, not this formatter's
// output; do not "fix" one to match the other.)
//
// A pino major that changed any of this would ship green through CI, the build, and the synthetic
// turn. That is why `pino` sits in dependabot.yml's npm-major exclude-patterns, and why
// loggerShape.spec.ts exists next to this file: it turns "read the changelog carefully" into a check
// that fails.
//
// Takes `dev` and `level` as arguments rather than importing them, which keeps this module free of
// $app/environment and $lib/chat/server/config. That is what lets the spec import it directly and
// exercise the real mixin against a real AsyncLocalStorage context instead of a hand-built copy of
// these options — a copy would drift, and would be measuring itself.
import { createRequire } from "node:module";
import type { LoggerOptions } from "pino";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { redactBareErrorMessage, redactLogObject, redactingErrSerializer } from "$lib/chat/server/logRedaction";

export function buildLoggerOptions({
	dev,
	level,
	env,
	commit,
	branch,
	instance,
}: {
	dev: boolean;
	level: string;
	/** The deployment environment, stamped on every line as `env`. Without it the
	 *  `aipotluck` Axiom dataset cannot tell production from preview, and every production-only (CUR-2057)
	 *  measurement had to join through the Vercel drain's `vercel.environment` instead. */
	env?: string;
	/** The commit and branch that built this deployment, stamped as `commit` and `branch`.
	 *  Preview's background lines (warm, cron) carry no request host, so `branch` is what tells (CUR-2019)
	 *  develop's lines from a PR preview's in the Vercel drain. */
	commit?: string;
	branch?: string;
	/** Which production instance (instance.ts), stamped as `instance`. Every production
	 *  instance logs as `env=production`, `branch=main`, and some send nothing to the Vercel drain, so (CUR-3202)
	 *  `instance` is the only way to tell their lines apart. */
	instance?: string;
}): LoggerOptions {
	return {
		// Dev only, and it must STAY dev only: pino-pretty replaces the JSON object with colorized
		// text, so a transport reaching production would break every log query at once rather than
		// subtly.
		//
		// The target is an absolute path. pino resolves a bare name from its callers' files,
		// and from 10.4.0 it reads them with `util.getCallSites()`, which skips a module vite evaluates.
		// Under SvelteKit's dev server the callers left are kit's own files, which can't see
		// pino-pretty, so pino threw on every route that logged. (CUR-3977)
		...(dev
			? { transport: { target: createRequire(import.meta.url).resolve("pino-pretty"), options: { colorize: true } } }
			: {}),
		// The log text goes under `message`, not pino's default `msg`.
		messageKey: "message",
		level,
		formatters: {
			// The label ("warn"), not pino's numeric level (40). Queries filter on the word.
			level: (label) => ({ level: label }),
			// User content and identity never leave the process; see logRedaction.ts. (CUR-1721)
			log: redactLogObject,
		},
		serializers: { err: redactingErrSerializer, error: redactingErrSerializer },
		hooks: { logMethod: redactBareErrorMessage },
		// Request context, flattened to top-level snake_case keys so a query can say
		// `where request_id == "…"` rather than reaching through a nested object. Absent keys are
		// omitted rather than sent as null — a null would match `isnotnull()` filters.
		mixin() {
			const result: Record<string, string | number> = {};
			if (env) result.env = env;
			if (commit) result.commit = commit;
			if (branch) result.branch = branch;
			if (instance) result.instance = instance;

			const ctx = getRequestContext();
			if (!ctx) return result;

			if (ctx.requestId) result.request_id = ctx.requestId;
			if (ctx.url) result.url = ctx.url;
			if (ctx.user) result.user = ctx.user;
			if (ctx.statusCode) result.status_code = ctx.statusCode;
			return result;
		},
	};
}
