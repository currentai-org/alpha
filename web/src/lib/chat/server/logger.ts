import pino from "pino";
import { dev } from "$app/environment";
import { config } from "$lib/chat/server/config";
import { buildLoggerOptions } from "$lib/chat/server/loggerOptions";
import { createAxiomStream } from "$lib/chat/server/axiomStream";
import { deploymentInstance } from "$lib/chat/server/instance";

// The options live in loggerOptions.ts, which is where the log-line shape is documented and tested.
// This file exists to supply the values that come from SvelteKit and app config, and to decide where
// the lines go.

// AXIOM_TOKEN and AXIOM_DATASET are the ADDRESS of the log sink, not a switch for a feature — the
// same category as DATABASE_URL, and the reason this is config rather than a PostHog flag. A flag
// would also have to be fetched at runtime, and the logger is built at module load, before there is
// anywhere to report that the fetch failed.
//
// Half-configured is the case worth being loud about. One of the two set means somebody intended
// shipping and it is not happening, which is precisely the silent-off shape the config model exists
// to prevent — so say so on stderr, where it lands in stdout capture either way.
function buildAxiomStream(
	token: string | undefined,
	dataset: string | undefined,
	[tokenKey, datasetKey]: [string, string]
) {
	if (dev || (!token && !dataset)) return undefined; // stdout, exactly as before

	if (!token || !dataset) {
		process.stderr.write(
			`[axiom] REFUSING to ship: ${token ? datasetKey : tokenKey} is missing. ` +
				`Logs go to stdout only. Set both or neither.\n`
		);
		return undefined;
	}
	return createAxiomStream({ token, dataset, edgeUrl: config.AXIOM_INGEST_URL || undefined });
}

const axiomStream = buildAxiomStream(config.AXIOM_TOKEN, config.AXIOM_DATASET, ["AXIOM_TOKEN", "AXIOM_DATASET"]);
// Security events also go to their own dataset, kept longer than the app logs. (CUR-4143)
const securityStream = buildAxiomStream(config.AXIOM_SECURITY_TOKEN, config.AXIOM_SECURITY_DATASET, [
	"AXIOM_SECURITY_TOKEN",
	"AXIOM_SECURITY_DATASET",
]);
// Additive. stdout still receives every byte it did before, so the Vercel drain is unaffected and
// both paths can run through the cutover.
const destination = axiomStream
	? pino.multistream([{ stream: process.stdout }, { stream: axiomStream }])
	: undefined;
const securityDestination = securityStream
	? pino.multistream([
			{ stream: process.stdout },
			...(axiomStream ? [{ stream: axiomStream }] : []),
			{ stream: securityStream },
		])
	: undefined;
// Read here rather than through deployEnv(), which imports this logger. Same order it
// uses: DEPLOY_ENV first, VERCEL_ENV as the fallback. (CUR-2057)
const env = process.env.DEPLOY_ENV || process.env.VERCEL_ENV || undefined;
const options = buildLoggerOptions({
	dev,
	level: config.LOG_LEVEL || "info",
	env,
	// Vercel sets both at build and runtime; absent locally, where they are omitted. (CUR-2019)
	commit: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
	branch: process.env.VERCEL_GIT_COMMIT_REF || undefined,
	instance: instanceForLogs(),
});

export const logger = destination ? pino(options, destination) : pino(options);

/** For security events (CUR-4143): a sign-in, a rate-limit trip, a refused email send, a blocked fetch.
 *  Each line goes everywhere `logger`'s does and also to AXIOM_SECURITY_DATASET, which is kept longer.
 *  A line here records the client network itself, as `ipHash`, since only the Vercel drain sees the
 *  raw address. Without the security dataset configured this is `logger`. */
export const securityLogger = securityDestination ? pino(options, securityDestination) : logger;

/** The logger must come up even when INSTANCE is malformed, so the error betterAuth.ts throws for it
 *  can be logged; that line then carries no `instance`. */
function instanceForLogs(): string | undefined {
	try {
		return deploymentInstance(process.env);
	} catch {
		return undefined;
	}
}
