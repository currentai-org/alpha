import type { MessageFile } from "$lib/chat/types/Message";
import {
	type MessageUpdate,
	MessageUpdateType,
	MessageUpdateStatus,
	PRESTREAM_EVENTS_HEADER,
	PRESTREAM_STARTING_PHASE,
	PRESTREAM_ACCEPTED_PHASE,
} from "$lib/chat/types/MessageUpdate";
import type { StreamingMode } from "$lib/chat/types/Settings";
import type { SearchContext } from "$lib/chat/types/Search";
import type { AgentMode } from "$lib/chat/stores/agentMode";
import type { AutoRouteNote } from "$lib/chat/routing/state";
import type { WebSearchMode } from "$lib/chat/stores/webSearchMode";
import type { SpeakMode } from "$lib/chat/stores/speakMode";
import { retryWithBackoff } from "./backoff";
import { noteHeartbeat, noteStreamSettled } from "$lib/chat/stores/connectionState";

type MessageUpdateRequestOptions = {
	base: string;
	inputs?: string;
	messageId?: string;
	isRetry: boolean;
	isContinue?: boolean;
	// Re-attach `messageId` to the agent task it already started (CUR-993).
	agentAttach?: boolean;
	// Client-chosen id for this generation run, echoed back by stop-generating
	// so the server can match a stop point to the run it belongs to
	generationId?: string;
	// The ids the page minted for this turn's new messages, so the server's copy matches (CUR-2098).
	newMessageIds?: { user?: string; assistant?: string };
	files?: MessageFile[];
	// User's IANA timezone (e.g. "America/New_York")
	timezone?: string;
	streamingMode?: StreamingMode;
	// Not read for grounding: the POST handler ignores it (web search runs SERVER-side and the grounding
	// gate, relevanceVerified, lives there; see requestSchema.ts + conversation/[id]/+server.ts). Kept
	// for older clients that still send it; never trusted as verified evidence.
	searchContext?: SearchContext;
	// Open-web search preference for this turn (composer globe control): off = never, auto = community
	// first then web if insufficient, always = web always. The server sequences community-first and
	// decides the web fallback; this just forwards the user's per-device choice.
	webSearchMode?: WebSearchMode;
	// Speak mode "always": synthesize + speak every answer (composer Speak control). The server reads this
	// to TTS the generated answer with the open component after generating it.
	// Fallback for older clients: a new server prefers `speakMode` and only uses
	// `speakAll` when `speakMode` is absent. Derivable as `speakMode === "always"`.
	speakAll?: boolean;
	// Full speak preference for this turn (composer Speak control): off = never synthesize, auto = speak
	// on a read-aloud request, always = speak every answer. Mirrors webSearchMode's tri-state so the
	// server can honor "off" (which `speakAll` alone can't express — it collapses off and auto to false).
	speakMode?: SpeakMode;
	// Agent toggle for this turn (composer Agent control): "off" = normal model, "on" = force the agent,
	// "auto" = the server asks the agent service's /route classifier whether to route. The send path reads
	// $agentMode and forwards it; the server's resolveAgentRoute consumes it.
	agentMode?: AgentMode;
	// Auto chose this turn's model in the browser; the server keeps it on the answer. (CUR-3944)
	autoRoute?: AutoRouteNote;
	// Mint + adopt a FRESH generationId for a retry AFTER a 5xx (a dead claim). The caller owns the id (the
	// stop-generating path reads its live value), so this both returns the new id and updates the caller's
	// copy. A connect-drop retry does NOT call this — it reuses the id so W2 idempotency can 409-attach.
	advanceGenerationId?: () => string;
	// Fired once per event consumed while vetting the pre-stream phase (see vetPrestream). The page
	// passes its first-token-watchdog re-arm here: vetted events never reach the page's update loop
	// (they're buffered), so without this the silence-based watchdog would false-fire during a
	// legitimately slow pre-stream chain even though the server is heartbeating.
	onPrestreamEvent?: () => void;
	// Injectables for deterministic tests (no real network/timers) — threaded into BOTH retry layers
	// (connectWithRetry and the vet-level retry). Never set in production code.
	connectRetryOptions?: ConnectRetryOptions;
};

type ChunkDetector = (buffer: string) => string | null;

type SmoothStreamConfig = {
	minDelayMs?: number;
	maxDelayMs?: number;
	minRateCharsPerMs?: number;
	maxBufferedMs?: number;
	_internal?: {
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
		detectChunk?: ChunkDetector;
	};
};

/**
 * Thrown when the server returns 409 for a duplicate generationId (W2 idempotency): the SAME logical
 * turn is already running or finished server-side — a network auto-retry (W3) re-POSTed it. The caller
 * treats this as "attach to the existing run", NOT an error worth a toast or a second submission.
 */
/** The answer's body stopped being readable after the response arrived: the visitor went
 *  offline or a proxy cut the line. It extends TypeError, which is what the browser's own read rejects
 *  with, so checks written for that keep working; the page's dropped-connection notice asks (CUR-2912)
 *  `isLateConnectionLoss`, which accepts this class alone, so a TypeError from our own code shows its own message instead. */
class StreamReadError extends TypeError {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "StreamReadError";
	}
}

/** Whether an error thrown after the answer started showing means the connection dropped.
 *  The conversation page asks this before showing its dropped-connection notice, so a TypeError from (CUR-2912)
 *  our own code falls through to its own message. */
export function isLateConnectionLoss(err: unknown): boolean {
	return err instanceof StreamReadError;
}

export class GenerationConflictError extends Error {
	readonly status: "in_flight" | "complete" | "error";
	readonly conversationId: string;
	readonly messageId?: string;
	constructor(info: { status: string; conversationId: string; messageId?: string }) {
		super(`generation already ${info.status}`);
		this.name = "GenerationConflictError";
		this.status = info.status === "complete" || info.status === "error" ? info.status : "in_flight";
		this.conversationId = info.conversationId;
		this.messageId = info.messageId;
	}
}

/**
 * Thrown when the generation POST comes back with a non-OK HTTP status other than 409 (e.g. a 5xx from a
 * killed/cold serverless invocation, or a 4xx). Carries the numeric `status` so the caller can branch on
 * it — a 5xx means the turn may have left an orphaned in-flight claim server-side with no terminal write
 * (a platform kill runs no catch/finally), so the client must fail the turn itself rather than wait for
 * the stale-generation backstop. Extends Error, so existing `instanceof Error` / `.message` handling is
 * unchanged.
 */
export class GenerationRequestError extends Error {
	readonly status: number;
	/** Where the failure surfaced: "http" = a real HTTP status (old server or infra-level error, which
	 *  already went through connectWithRetry's own 5xx retry budget); "stream" = a pre-stream failure
	 *  EVENT from the prestream-events protocol, or the stream closing before a verdict (a killed
	 *  invocation). Only "stream" ≥500s are retried at the vet level — retrying "http" ones too would
	 *  multiply the two budgets (3×3 POSTs) against a persistently-down server. */
	readonly source: "http" | "stream";
	/** On a 429 from our own message limit: whole seconds until a send can pass (CUR-3216). */
	readonly retryAfterSeconds?: number;
	constructor(
		status: number,
		message: string,
		source: "http" | "stream" = "http",
		retryAfterSeconds?: number
	) {
		super(message);
		this.source = source;
		this.retryAfterSeconds = retryAfterSeconds;
		this.name = "GenerationRequestError";
		this.status = status;
	}
}

/** Connect-establishment timeout (ms). fetch() itself has no timeout — on a flaky shared network the
 *  request can hang in the TCP/TLS/headers phase with neither a response nor an error. This bounds
 *  getting the response HEADERS only; it is deliberately separate from the 8s time-to-first-token
 *  watchdog in +page.svelte, which guards a connected-but-silent stream.
 *
 *  Sizing: with the prestream-events protocol the server flushes headers + a first byte BEFORE its
 *  pre-stream chain runs, so a healthy connect is bounded by cold-start boot alone. A lower bound would fire on
 *  slow-but-alive requests (TTFB P75 2.17s + cold boot), re-POSTing a duplicate of the SAME turn and
 *  landing in the 409-conflict path, which looks like "message sent then disappeared". 6500
 *  absorbs a bad cold boot while keeping flaky-network recovery bounded. */
const CONNECT_TIMEOUT_MS = 6500;
/** Total connect attempts, including the first. 3 = first + 2 jittered retries. */
const CONNECT_ATTEMPTS = 3;

/** A pre-first-byte connect failure that is safe to retry: a network-layer fetch throw (no response:
 *  DNS/TCP/TLS/offline → TypeError) or our own connect-timeout abort. Caller-initiated aborts (user
 *  Stop / watchdog / navigation) are excluded by the shouldRetry guard, not here. */
function isConnectError(err: unknown): boolean {
	if (err instanceof TypeError) return true;
	if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError"))
		return true;
	return false;
}

export interface ConnectRetryOptions {
	timeoutMs?: number;
	attempts?: number;
	/** Injectables for deterministic tests (no real network/timers). */
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
	/** Treat a Response with this status as retriable — re-POST it under the SAME backoff+jitter as a
	 *  connect drop, so a fast 5xx from a cold/killed serverless invocation recovers through one path,
	 *  not a second bespoke loop. Omit → any Response is returned as-is (the pre-existing contract:
	 *  "status is the caller's"). The final attempt's response is returned intact for the caller to read. */
	retryStatus?: (status: number) => boolean;
}

/** Internal sentinel: a Response whose status `retryStatus` marked retriable. Thrown so the shared
 *  retryWithBackoff loop treats it like a connect failure; unwrapped back to its Response if the
 *  retries are exhausted (so the caller still sees the real status/body). */
class RetriableStatusError extends Error {
	constructor(readonly response: Response) {
		super(`retriable status ${response.status}`);
		this.name = "RetriableStatusError";
	}
}

/**
 * Open the generation stream with a connect-timeout and pre-first-byte jittered auto-retry. Returns
 * the Response once the headers arrive; the caller handles status (409/!ok/body) and streams the body.
 *
 * Retry scope is the CONNECT phase only — this resolves before any NDJSON byte is read, so a turn that
 * has already started streaming can never be silently restarted (no retry after
 * the first byte, by construction). The generationId rides in the request body unchanged across
 * attempts; W2 idempotency makes the duplicate POST safe (the server returns 409 → the caller attaches
 * to the existing run rather than double-generating). Full-jitter backoff spreads reconnects so a room
 * full of clients recovering from the same micro-drop doesn't thundering-herd.
 */
export async function connectWithRetry(
	url: string,
	init: RequestInit | ((attempt: number, prevRetriableStatus: boolean) => RequestInit),
	callerSignal: AbortSignal,
	opts: ConnectRetryOptions = {}
): Promise<Response> {
	const {
		timeoutMs = CONNECT_TIMEOUT_MS,
		attempts = CONNECT_ATTEMPTS,
		fetchImpl = fetch,
		sleep,
		random,
		onRetry,
		retryStatus,
	} = opts;
	// A per-attempt init factory lets the caller rebuild the request each try. Its second arg says whether
	// the PRIOR attempt failed with a retriable status (a 5xx) — this is load-bearing: only THEN should the
	// caller mint a fresh idempotency key (the prior claim is dead). After a connect drop the caller must
	// REUSE the key so W2 idempotency attaches to a possibly-live server run (409) instead of double-firing.
	const buildInit = typeof init === "function" ? init : () => init;
	// Whether the immediately-preceding attempt threw a RetriableStatusError. Fed to the next buildInit.
	let priorRetriableStatus = false;

	try {
		return await retryWithBackoff(
			async (attempt) => {
				const prevRetriableStatus = priorRetriableStatus;
				priorRetriableStatus = false; // set true below only if THIS attempt is a retriable status
				// Caller already gave up before we (re)connected — don't open a connection against it.
				if (callerSignal.aborted) throw new DOMException("Aborted", "AbortError");

				// Per-attempt controller: fires on our connect-timeout OR a caller abort, whichever first.
				const timeoutController = new AbortController();
				const onCallerAbort = () => timeoutController.abort();
				callerSignal.addEventListener("abort", onCallerAbort);
				const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
				try {
					const res = await fetchImpl(url, {
						...buildInit(attempt, prevRetriableStatus),
						signal: timeoutController.signal,
					});
					// A retriable status (fast 5xx from a cold/killed invocation) is thrown so the SAME
					// backoff loop that handles connect drops recovers it — one cold-start path. On the last
					// attempt we keep the body and hand the response back (the catch below); on earlier
					// attempts we cancel the discarded body so it can't leak a held connection.
					if (retryStatus?.(res.status)) {
						priorRetriableStatus = true; // the next attempt must mint a fresh idempotency key
						if (attempt < attempts - 1) void res.body?.cancel().catch(() => {});
						throw new RetriableStatusError(res);
					}
					return res;
				} finally {
					clearTimeout(timer);
					callerSignal.removeEventListener("abort", onCallerAbort);
				}
			},
			{
				attempts,
				onRetry,
				...(sleep ? { sleep } : {}),
				...(random ? { random } : {}),
				shouldRetry: (err) => {
					// Never retry once the caller aborted: a user Stop / TTFT watchdog / navigation is intent,
					// not a flaky link — re-POSTing would fight the user. (A caller abort surfaces here as an
					// AbortError too, so this guard, not isConnectError, is what excludes it.)
					if (callerSignal.aborted) return false;
					return isConnectError(err) || err instanceof RetriableStatusError;
				},
			}
		);
	} catch (err) {
		// Retries exhausted on a retriable status → return the final response so the caller reads its
		// status/body exactly as if we hadn't retried. A connect-class failure still propagates.
		if (err instanceof RetriableStatusError) return err.response;
		throw err;
	}
}

/** Total connect+vet attempts at the vet level (each may itself use connectWithRetry's connect
 *  budget, but the two layers retry DISJOINT failure classes — see GenerationRequestError.source). */
const VET_ATTEMPTS = 3;

/**
 * Vet the pre-stream phase of a just-opened generation stream (prestream-events protocol; see the
 * server's runPrestream). The server flushed headers before running its pre-stream chain, so the
 * chain's outcome arrives as EVENTS: `phase:starting` keepalives while it runs, then EITHER a
 * Status/Error carrying `statusCode` (the failure the HTTP status used to be) OR the accepted
 * marker (chain passed; real updates follow). This translates failures back into the exact typed
 * errors the HTTP statuses produced — thrown BEFORE the iterator is returned, so every existing
 * caller-side failure path (conflict attach, rate-limit composer restore, 5xx early-fail) is
 * untouched.
 *
 * Deploy-skew: an OLD server's failures are real HTTP statuses (handled before this runs), so by
 * the time any event arrives its chain has already passed — the first non-starting event accepts,
 * whatever it is, and is replayed to the caller.
 */
async function vetPrestream(
	source: AsyncGenerator<MessageUpdate>,
	conversationId: string,
	onPrestreamEvent?: () => void
): Promise<AsyncGenerator<MessageUpdate>> {
	const buffered: MessageUpdate[] = [];

	async function* replayThenDelegate(): AsyncGenerator<MessageUpdate> {
		for (const update of buffered) yield update;
		yield* source;
	}

	// Run the source generator to completion before throwing a verdict out of the vet. The
	// generator's own finally is what settles the connection-state store (noteStreamSettled) and
	// releases the reader — without this, an event-coded failure would abandon the generator
	// suspended mid-yield: the store still thinks a stream is live (a "reconnecting…" banner can
	// later flip stale) and the finally never runs. Best-effort; a settled generator is a no-op.
	const settleSource = async () => {
		try {
			await source.return(undefined);
		} catch {
			// already settled / return propagated a late stream error — either way it's finished
		}
	};

	for (;;) {
		const { done, value: update } = await source.next();
		if (done) {
			// Closed before any verdict: the invocation died between flushing headers and finishing its
			// chain (a platform kill runs no catch — no failure event either). Retryable, like the fast
			// HTTP 5xx. (The generator already completed — nothing to settle.)
			throw new GenerationRequestError(
				502,
				"The stream closed before the turn started.",
				"stream"
			);
		}
		onPrestreamEvent?.();

		if (update.type === MessageUpdateType.Status) {
			if (update.status === MessageUpdateStatus.Error && typeof update.statusCode === "number") {
				await settleSource();
				if (update.statusCode === 409) {
					// W2 idempotency conflict, event-coded: same typed error the HTTP 409 produced, so the
					// caller attaches to the existing run rather than toasting or double-submitting.
					const conflict = update.conflict ?? {};
					throw new GenerationConflictError({
						status: typeof conflict.status === "string" ? conflict.status : "in_flight",
						conversationId:
							typeof conflict.conversationId === "string"
								? conflict.conversationId
								: conversationId,
						messageId:
							typeof conflict.messageId === "string" ? conflict.messageId : undefined,
					});
				}
				throw new GenerationRequestError(
					update.statusCode,
					update.message ?? `Request failed with status code ${update.statusCode}`,
					"stream",
					update.retryAfterSeconds
				);
			}
			if (
				update.status === MessageUpdateStatus.KeepAlive &&
				update.message === PRESTREAM_STARTING_PHASE
			) {
				// Chain still running — buffer (replayed so the page's phase indicator behaves as today).
				buffered.push(update);
				continue;
			}
			if (
				update.status === MessageUpdateStatus.KeepAlive &&
				update.message === PRESTREAM_ACCEPTED_PHASE
			) {
				// Chain passed. The marker is protocol, not content — swallow it.
				return replayThenDelegate();
			}
		}

		// Anything else is a real update — on a new server that only happens after the accepted
		// marker (unreachable here), on an old server it's the proof its chain already passed.
		buffered.push(update);
		return replayThenDelegate();
	}
}

export async function fetchMessageUpdates(
	conversationId: string,
	opts: MessageUpdateRequestOptions,
	abortSignal: AbortSignal
): Promise<AsyncGenerator<MessageUpdate>> {
	// Build the multipart body PER ATTEMPT. The generationId advances (via advanceGenerationId) ONLY when
	// the prior attempt failed with a 5xx — that claim is dead, so a fresh id avoids 409-attaching to it.
	// A connect-drop retry (prevRetriableStatus false) REUSES the id so the server's W2 idempotency attaches
	// to a possibly-live run instead of starting a second generation. currentGenerationId tracks the id in
	// use; advanceGenerationId also updates the caller's copy (the stop path reads its live value).
	let currentGenerationId = opts.generationId;
	const buildInit = (attempt: number, prevRetriableStatus: boolean): RequestInit => {
		if (attempt > 0 && prevRetriableStatus) {
			currentGenerationId = opts.advanceGenerationId?.() ?? currentGenerationId;
		}
		const generationId = currentGenerationId;
		const form = new FormData();
		form.append(
			"data",
			JSON.stringify({
				inputs: opts.inputs,
				id: opts.messageId,
				is_retry: opts.isRetry,
				agent_attach: opts.agentAttach,
				is_continue: Boolean(opts.isContinue),
				generationId,
				newMessageIds: opts.newMessageIds,
				timezone: opts.timezone,
				searchContext: opts.searchContext,
				webSearchMode: opts.webSearchMode,
				speakAll: opts.speakAll,
				speakMode: opts.speakMode,
				agentMode: opts.agentMode,
				autoRoute: opts.autoRoute,
			})
		);
		opts.files?.forEach((file) => {
			const name = file.type + ";" + file.name;
			form.append("files", new File([file.value], name, { type: file.mime }));
		});
		// Opt in to the prestream-events protocol: the server flushes headers + a first byte BEFORE
		// its pre-stream chain (so our connect-timeout can't fire mid-chain and re-POST a duplicate
		// turn) and delivers chain failures as events, vetted back into typed errors below. An old
		// server ignores the header and keeps today's HTTP-status behavior.
		return { method: "POST", body: form, headers: { [PRESTREAM_EVENTS_HEADER]: "1" } };
	};

	// Vet-level retry: with pre-stream failures event-coded, a dead-claim 5xx arrives IN the stream
	// instead of as a fast HTTP 5xx — so the "retry with a FRESH generationId" recovery that
	// connectWithRetry's retryStatus provides for HTTP statuses has to live here too. Only "stream"-sourced
	// ≥500s retry (HTTP ones already spent connectWithRetry's own budget); jitter and bounds match.
	return await retryWithBackoff(
		async (vetAttempt) => {
			if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
			// Reaching attempt N>0 means the prior attempt failed with a stream-sourced ≥500 — that
			// claim is dead (the server releases it best-effort, but never rely on it): mint a fresh id.
			if (vetAttempt > 0) {
				currentGenerationId = opts.advanceGenerationId?.() ?? currentGenerationId;
			}
			// Per-attempt controller: endpointStreamToIterator aborts ITS controller on stream
			// end/error, so reusing one across attempts would poison the next connect
			// (connectWithRetry refuses an aborted signal). Wired to the caller's signal; on a failed
			// attempt the wiring is undone and the attempt's stream released before the retry.
			const attemptController = new AbortController();
			const onCallerAbort = () => attemptController.abort();
			abortSignal.addEventListener("abort", onCallerAbort);
			try {
				// One connect layer for both cold-start shapes: a short per-attempt timeout + jittered retry
				// recovers a connect drop (flaky wifi) AND a fast 5xx (cold/killed serverless invocation)
				// through the same backoff. Mid-stream abort still flows through `attemptController` →
				// reader.cancel() in endpointStreamToIterator; this only governs establishing the response.
				const response = await connectWithRetry(
					`${opts.base}/conversation/${conversationId}`,
					buildInit,
					attemptController.signal,
					{
						retryStatus: (status) => status >= 500,
						...opts.connectRetryOptions,
					}
				);

				if (response.status === 409) {
					// W2 idempotency: this generationId is already running/finished server-side (a duplicate
					// POST from a network auto-retry). Surface a typed conflict so the caller attaches to the
					// existing run rather than toasting an error or double-submitting.
					const info = (await response.json().catch(() => ({}))) as Record<string, unknown>;
					throw new GenerationConflictError({
						status: typeof info.status === "string" ? info.status : "in_flight",
						conversationId:
							typeof info.conversationId === "string" ? info.conversationId : conversationId,
						messageId: typeof info.messageId === "string" ? info.messageId : undefined,
					});
				}
				if (!response.ok) {
					const body = (await response.json().catch(() => undefined)) as
						| { message?: string; retryAfterSeconds?: number }
						| undefined;
					throw new GenerationRequestError(
						response.status,
						body?.message ??
							`Request failed with status code ${response.status}: ${response.statusText}`,
						"http",
						typeof body?.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined
					);
				}
				if (!response.body) {
					throw Error("Body not defined");
				}

				const vetted = await vetPrestream(
					endpointStreamToIterator(response, attemptController),
					conversationId,
					opts.onPrestreamEvent
				);
				return applyStreamingMode(vetted, opts.streamingMode ?? "smooth");
			} catch (err) {
				// A failed attempt must not leave the caller's signal wired to its dead controller, and
				// must release its stream (reader.cancel via abort) before a retry re-connects. On
				// SUCCESS the wiring stays — it is exactly how a later user Stop reaches the reader.
				abortSignal.removeEventListener("abort", onCallerAbort);
				attemptController.abort();
				// A caller abort mid-vet surfaces as the stream ENDING (reader.cancel resolves the read
				// as done) → a 502 from vetPrestream — but the user stopping / the watchdog firing is
				// intent, not a server failure. Re-surface it as the AbortError every existing handler
				// already swallows silently, exactly like an abort in any other phase.
				if (abortSignal.aborted && !(err instanceof DOMException)) {
					throw new DOMException("Aborted", "AbortError");
				}
				throw err;
			}
		},
		{
			attempts: VET_ATTEMPTS,
			shouldRetry: (err) =>
				!abortSignal.aborted &&
				err instanceof GenerationRequestError &&
				err.source === "stream" &&
				err.status >= 500,
			...(opts.connectRetryOptions?.sleep ? { sleep: opts.connectRetryOptions.sleep } : {}),
			...(opts.connectRetryOptions?.random ? { random: opts.connectRetryOptions.random } : {}),
		}
	);
}

export function applyStreamingMode(
	iterator: AsyncGenerator<MessageUpdate>,
	streamingMode: StreamingMode
): AsyncGenerator<MessageUpdate> {
	if (streamingMode === "smooth") {
		return smoothStreamUpdates(iterator);
	}

	// "raw" keeps source stream intact.
	return iterator;
}

export function resolveStreamingMode(s: { streamingMode?: unknown }): StreamingMode {
	return s.streamingMode === "raw" || s.streamingMode === "smooth" ? s.streamingMode : "smooth";
}

async function* endpointStreamToIterator(
	response: Response,
	abortController: AbortController
): AsyncGenerator<MessageUpdate> {
	const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
	if (!reader) throw Error("Response for endpoint had no body");

	// Handle any cases where we must abort. `reader.closed` REJECTS when the stream
	// errors (mid-stream network drop), so a bare `.then()` would both miss the
	// abort and leak an unhandled rejection; `.catch(() => abort())` covers the
	// error path too — the read loop below surfaces the actual error by rejecting.
	reader.closed.then(
		() => abortController.abort(),
		() => abortController.abort()
	);

	// Handle logic for aborting
	// cancel() on a body that already errored rejects with that error, which the read below has
	// already surfaced; left uncaught it is a second, unhandled copy of it.
	abortController.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));

	// ex) If the last response is => {"type": "stream", "token":
	// It should be => {"type": "stream", "token": "Hello"} = prev_input_chunk + "Hello"}
	let prevChunk = "";
	try {
		while (!abortController.signal.aborted) {
			let chunk: ReadableStreamReadResult<string>;
			try {
				chunk = await reader.read();
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") throw err;
				throw new StreamReadError(err);
			}
			const { done, value } = chunk;
			if (done) {
				abortController.abort();
				break;
			}
			if (!value) continue;

			// Every inbound chunk is proof the link is alive. Feed the shared connectivity store so a
			// mid-stream stall surfaces as "reconnecting…" in the indicator without any further wiring;
			// it's a cheap timestamp set and a no-op when the store is unmounted / on the server.
			noteHeartbeat();

			const { messageUpdates, remainingText } = parseMessageUpdates(prevChunk + value);
			prevChunk = remainingText;
			for (const messageUpdate of messageUpdates) yield messageUpdate;
		}
	} finally {
		// Stream settled (done, user-stop, navigation, or error) — disarm the heartbeat-staleness
		// watchdog so the now-idle connection isn't judged on ping-silence it can't avoid. Runs on
		// every exit path, including the consumer calling iterator.return() in smoothStreamUpdates.
		noteStreamSettled();
	}
}

function parseMessageUpdates(value: string): {
	messageUpdates: MessageUpdate[];
	remainingText: string;
} {
	const inputs = value.split("\n");
	const messageUpdates: MessageUpdate[] = [];
	for (const input of inputs) {
		try {
			messageUpdates.push(JSON.parse(input) as MessageUpdate);
		} catch (error) {
			// in case of parsing error, we return what we were able to parse
			if (error instanceof SyntaxError) {
				return {
					messageUpdates,
					remainingText: inputs.at(-1) ?? "",
				};
			}
		}
	}
	return { messageUpdates, remainingText: "" };
}

/** Time constant for the arrival-rate estimate: reacts within ~1s to pace changes. */
const ARRIVAL_RATE_TAU_MS = 1000;
/** Pace slightly above the estimated arrival rate so the queue trends empty. */
const ARRIVAL_RATE_HEADROOM = 1.1;
/** Boundary-less runs (hashes, base64, CJK without Intl.Segmenter) flush at this size. */
const MAX_PENDING_CHARS = 64;

export async function* smoothStreamUpdates(
	iterator: AsyncGenerator<MessageUpdate>,
	{
		minDelayMs = 5,
		maxDelayMs = 80,
		minRateCharsPerMs = 0.3,
		maxBufferedMs = 400,
		_internal: { now = () => performance.now(), sleep = defaultSleep, detectChunk } = {},
	}: SmoothStreamConfig = {}
): AsyncGenerator<MessageUpdate> {
	const chunkDetector = detectChunk ?? createWordChunkDetector();
	const queue: Array<{ update: MessageUpdate; arrivedAt: number }> = [];
	let queuedStreamChars = 0;
	let producerDone = false;
	let producerError: unknown = null;
	let pendingBuffer = "";

	let wakeConsumer: (() => void) | null = null;
	const wake = () => {
		wakeConsumer?.();
		wakeConsumer = null;
	};
	const nextWake = () =>
		new Promise<void>((resolve) => {
			wakeConsumer = resolve;
		});

	// Exponentially-decayed estimate of the source arrival rate (chars/ms).
	// Pacing the output at the rate text actually arrives keeps the cadence
	// steady through network burstiness instead of draining fast and freezing.
	let arrivalAcc = 0;
	let arrivalAt: number | null = null;
	const observeArrival = (chars: number) => {
		const t = now();
		if (arrivalAt !== null) arrivalAcc *= Math.exp((arrivalAt - t) / ARRIVAL_RATE_TAU_MS);
		arrivalAcc += chars;
		arrivalAt = t;
	};
	const arrivalRate = () =>
		arrivalAt === null
			? 0
			: (arrivalAcc * Math.exp((arrivalAt - now()) / ARRIVAL_RATE_TAU_MS)) / ARRIVAL_RATE_TAU_MS;

	const enqueue = (update: MessageUpdate) => {
		if (update.type === MessageUpdateType.Stream) {
			queuedStreamChars += update.token.length;
		}
		queue.push({ update, arrivedAt: now() });
		wake();
	};

	const flushPendingBuffer = () => {
		if (pendingBuffer.length === 0) return;
		enqueue({ type: MessageUpdateType.Stream, token: pendingBuffer });
		pendingBuffer = "";
	};

	// Updates rendered outside the message text flow (liveness pings, the
	// conversation title, the routed-model badge). They pass through without
	// flushing a partially-buffered word; anything else flushes first so text
	// never appears cut short next to tool/status/final updates.
	const isOutOfBand = (update: MessageUpdate): boolean =>
		update.type === MessageUpdateType.Title ||
		update.type === MessageUpdateType.RouterMetadata ||
		(update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.KeepAlive);

	const producer = (async () => {
		for await (const messageUpdate of iterator) {
			if (messageUpdate.type !== MessageUpdateType.Stream) {
				if (!isOutOfBand(messageUpdate)) flushPendingBuffer();
				enqueue(messageUpdate);
				continue;
			}

			if (!messageUpdate.token) continue;

			observeArrival(messageUpdate.token.length);
			pendingBuffer += messageUpdate.token;
			let chunk: string | null;
			while ((chunk = chunkDetector(pendingBuffer)) !== null && chunk.length > 0) {
				enqueue({ type: MessageUpdateType.Stream, token: chunk });
				pendingBuffer = pendingBuffer.slice(chunk.length);
			}
			if (pendingBuffer.length >= MAX_PENDING_CHARS) flushPendingBuffer();
		}
		flushPendingBuffer();
	})()
		.catch((error) => {
			producerError = error;
		})
		.finally(() => {
			producerDone = true;
			wake();
		});

	// Pacing: after emitting a chunk, reserve `chunkLen / targetRate` ms before
	// the next chunk may appear. A source slower than the target is never
	// delayed (its own gaps exceed the reservation, so the first word and every
	// word of a slow stream render the moment they arrive); a faster source is
	// spread out evenly. No chunk is ever held more than maxBufferedMs past its
	// arrival, and the catch-up rate drains a backlog linearly by that deadline
	// rather than dumping it all at once.
	let nextEmitAt = 0;
	try {
		for (;;) {
			const entry = queue.shift();
			if (!entry) {
				if (producerDone) break;
				await nextWake();
				continue;
			}

			const { update } = entry;
			if (update.type !== MessageUpdateType.Stream) {
				yield update;
				continue;
			}

			const deadline = maxBufferedMs > 0 ? entry.arrivedAt + maxBufferedMs : Infinity;
			const waitMs = Math.round(Math.min(nextEmitAt, deadline) - now());
			if (waitMs > 0) await sleep(waitMs);

			queuedStreamChars -= update.token.length;
			yield update;

			const catchUpRate = maxBufferedMs > 0 ? queuedStreamChars / Math.max(1, deadline - now()) : 0;
			const targetRate = Math.max(
				arrivalRate() * ARRIVAL_RATE_HEADROOM,
				minRateCharsPerMs,
				catchUpRate
			);
			const effectiveMinDelayMs = catchUpRate > minRateCharsPerMs ? 0 : minDelayMs;
			const spacingMs = Math.max(
				effectiveMinDelayMs,
				Math.min(maxDelayMs, update.token.length / targetRate)
			);
			nextEmitAt = now() + spacingMs;
		}

		await producer;
		if (producerError) throw producerError;
	} finally {
		// Stop pulling from the source if our consumer stops early.
		void iterator.return(undefined);
	}
}

function createWordChunkDetector(): ChunkDetector {
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
		return (buffer: string): string | null => {
			if (buffer.length === 0) return null;
			let sawWord = false;

			for (const part of segmenter.segment(buffer)) {
				if (!sawWord) {
					sawWord = Boolean(part.isWordLike);
					continue;
				}
				// A new word begins right after the previous one: split before it.
				// This is what gives word-level cadence to CJK text, which has no
				// whitespace between words.
				if (part.isWordLike) return buffer.slice(0, part.index);
				// Whitespace is always a safe split point: split after it.
				if (/\s/.test(part.segment)) return buffer.slice(0, part.index + part.segment.length);
				// Trailing punctuation stays attached to the word before it.
			}

			return null;
		};
	}

	const wordWithTrailingBoundary = /\S+\s+/m;
	return (buffer: string): string | null => {
		const match = wordWithTrailingBoundary.exec(buffer);
		if (!match) return null;
		return buffer.slice(0, match.index) + match[0];
	};
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
