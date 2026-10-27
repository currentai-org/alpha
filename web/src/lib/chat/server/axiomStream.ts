// Ship server logs to Axiom from the app instead of relying on the host to do it.
//
// Today Axiom is fed by Vercel's log-drain integration, which is the host's job and not ours. On
// Jelastic there is no drain, and losing it produces no signal at all: the surface with our only real
// retention would simply stop receiving, and "no rows" reads identically to "a quiet week". This
// stream is the replacement, and it follows agent-service, which already ingests app-side rather than
// through any platform integration.
//
// ADDITIVE, DELIBERATELY. logger.ts composes this alongside stdout via pino.multistream, so the exact
// bytes that go to stdout today still go to stdout — the Vercel drain is untouched and both paths can
// run at once through the cutover. Nothing here changes the shape of a log line; see loggerOptions.ts,
// which owns that and is tested for it.
//
// NOT A pino TRANSPORT. pino's `transport` option spawns a worker thread and resolves the target by
// module path at runtime, which a bundled adapter-node build makes fragile for no gain here — the
// batching that a worker would buy us is what this file does anyway, without the resolution problem.
//
// THE FAILURE MODE THIS IS BUILT AROUND is Axiom being slow or unreachable while the app keeps
// logging. A stream that awaits its POST would put an external service in the path of every log
// call, and an unbounded buffer would turn a stalled sink into an app OOM. So: fixed-size queue, oldest dropped
// first, drops counted and reported. Losing the tail of a log batch is the correct thing to lose.
import { Writable } from "node:stream";

const INGEST_HOST = "https://api.axiom.co";
// Flush on whichever comes first. 100 lines is well inside Axiom's request limits, and one second is
// short enough that a crash loses at most a second of context.
const BATCH_LINES = 100;
const FLUSH_MS = 1_000;
// ~5 MB of JSON at a generous 1 KB/line. Past this the app is producing logs faster than they can be
// shipped, and the only question left is which end of the queue to lose.
const MAX_QUEUED = 5_000;

export interface AxiomStreamOptions {
	token: string;
	dataset: string;
	/** Override for tests. */
	url?: string;
	/** The dataset's edge deployment URL (AXIOM_INGEST_URL), e.g. https://eu-central-1.aws.edge.axiom.co.
	 *  api.axiom.co refuses ingest into a dataset outside the org's default (US) edge with a 400, so a
	 *  dataset on another edge is written through that edge's own ingest path (CUR-646). */
	edgeUrl?: string;
	/** Injected so the spec does not have to reach for global fetch. */
	fetchImpl?: typeof fetch;
	/** Where to report our own failures. Never the logger — that would recurse. */
	onError?: (message: string) => void;
}

export interface AxiomStream extends Writable {
	/** Send anything queued and wait for it. For shutdown, and for the spec. */
	flushNow(): Promise<void>;
	/** Lines dropped because the queue was full, since process start. */
	droppedCount(): number;
}

/** Where to POST a dataset's events: the edge's own ingest path when the dataset lives on a non-default
 *  edge, otherwise the default-edge path on api.axiom.co. */
function axiomIngestEndpoint(dataset: string, edgeUrl?: string, host: string = INGEST_HOST): string {
	const name = encodeURIComponent(dataset);
	const edge = edgeUrl?.trim().replace(/\/+$/, "");
	return edge ? `${edge}/v1/ingest/${name}` : `${host}/v1/datasets/${name}/ingest`;
}

export function createAxiomStream(opts: AxiomStreamOptions): AxiomStream {
	const { token, dataset } = opts;
	const doFetch = opts.fetchImpl ?? fetch;
	const endpoint = axiomIngestEndpoint(dataset, opts.edgeUrl, opts.url);
	const report = opts.onError ?? ((m: string) => process.stderr.write(`[axiom] ${m}\n`));

	// ONE request in flight at a time, and everything else waits in `queue`. The obvious alternative —
	// chaining each batch onto a promise as it is cut — moves the lines out of the bounded queue and
	// into an unbounded chain of pending closures, so the cap below guards nothing and an Axiom that
	// accepts connections but never answers grows memory exactly as if there were no cap at all. The
	// spec's queue-bound case pins this.
	const queue: string[] = [];
	let dropped = 0;
	let timer: NodeJS.Timeout | undefined;
	let sending = false;
	const waiters: Array<() => void> = [];

	async function send(batch: string[]): Promise<void> {
		if (batch.length === 0) return;
		try {
			const res = await doFetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/x-ndjson",
				},
				body: batch.join("\n"),
			});
			if (!res.ok) {
				// A 4xx here is ours to fix — a wrong dataset name or a token without ingest scope both
				// land here — so say which, rather than "ingest failed".
				report(`ingest ${res.status} for dataset "${dataset}" (${batch.length} lines dropped)`);
			}
		} catch (err) {
			report(`ingest unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function pump(): void {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (sending) return;
		if (queue.length === 0) {
			while (waiters.length) waiters.shift()?.();
			return;
		}
		sending = true;
		const batch = queue.splice(0, BATCH_LINES);
		void send(batch).then(() => {
			sending = false;
			pump();
		});
	}

	function scheduleFlush(): void {
		if (timer) return;
		timer = setTimeout(pump, FLUSH_MS);
		// A pending flush must not be the reason the process stays alive.
		timer.unref?.();
	}

	const stream = new Writable({
		// pino hands us one serialized JSON line per write.
		write(chunk, _encoding, callback) {
			const line = chunk.toString().trim();
			if (line) {
				if (queue.length >= MAX_QUEUED) {
					queue.shift();
					dropped++;
				}
				queue.push(stampTime(line));
				if (queue.length >= BATCH_LINES) pump();
				else scheduleFlush();
			}
			// Always succeed. A logging sink that reports failure back into the app is a logging sink
			// that can take the app down.
			callback();
		},
		final(callback) {
			stream.flushNow().then(
				() => callback(),
				() => callback()
			);
		},
	}) as AxiomStream;

	stream.flushNow = () =>
		new Promise<void>((resolve) => {
			waiters.push(resolve);
			pump();
		});
	stream.droppedCount = () => dropped;

	return stream;
}

// Axiom timestamps a row at ingest unless the payload carries `_time`. That difference shows up
// exactly when it hurts: when shipping lags and the ordering you are reading is
// the ordering of delivery rather than of events. pino writes epoch millis as `time`; promote it.
// A line we cannot parse still gets shipped — dropping a log line to protect its timestamp is the
// wrong trade.
function stampTime(line: string): string {
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		if (obj._time === undefined && typeof obj.time === "number") {
			obj._time = new Date(obj.time).toISOString();
			return JSON.stringify(obj);
		}
	} catch {
		/* not JSON, or not the shape we expect — ship it as-is */
	}
	return line;
}
