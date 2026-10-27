// The `model_replay` fault answers a model call from a recording, so a scenario spec that
// checks what our pipeline does around an answer (the routing record, the provenance badge, the stream
// filters) runs that pipeline for real without paying for a live answer, or failing on one.
//
// Only the model's bytes are replayed. The request is built as usual and the response goes through
// customFetch's provenance reads and the stream converters exactly as a live one would.
//
// A recording is keyed by the request: its path and its JSON body, with the values that change on
// every turn of the same conversation written out (the injection fence's nonce, the prompt's date
// line). SOL-148: a recording is looked up in this branch's scope, then develop's, in a store every run
// shares (replayStore.ts), and last among the cassettes committed with the build. The two modes follow
// VCR.py's record modes. `new_episodes`: a miss calls the live model and records it under this branch,
// so a changed prompt costs one live call and the next run hits. `none`: a miss fails the call, which
// is how a run proves it made no live model call at all. (SOL-92)

import { createHash } from "node:crypto";
import { logger } from "$lib/chat/server/logger";
import { lookup, record } from "./replayStore";

/** What a recording holds: enough of the response for customFetch and the SDK to treat it as live. */
export type Cassette = {
	/** The request hash from replayKey(). Not named `key`: gitleaks reads a hex string under that name as a credential. */
	requestHash: string;
	path: string;
	/** The upstream host the request went to. A recording without one is never read by another branch. */
	host?: string;
	status: number;
	headers: Record<string, string>;
	body: string;
	recordedAt: string;
	/** Set on a recorded 429, which is replayed only until then (replayStore.ts). (CUR-3982) */
	refusedUntil?: string;
};

/** The response headers worth keeping: the body's type, and every provenance report customFetch reads. */
const KEPT_HEADER = /^(content-type|x-litellm-.*|x-router-.*|x-inference-provider)$/i;

/**
 * The HF router reports the provider that served in `x-inference-provider`, and customFetch reads a
 * turn's served model from it (endpointOai.ts). Recordings made before the header was kept replay a
 * GLM turn with no served model, so a recording from this host without it is refreshed like a stale one.
 */
const HF_ROUTER_HOST = "router.huggingface.co";
const lacksProvider = (c: Cassette) =>
	c.host === HF_ROUTER_HOST &&
	c.status === 200 &&
	!Object.keys(c.headers).some((k) => k.toLowerCase() === "x-inference-provider");

/** Set on a replayed response, naming when the recording was made. */
export const REPLAY_HEADER = "x-model-replay";

/** Set on a mock answer: no recording matched, and no model was called. */
const MOCK_HEADER = "x-model-mock";

/** The text of every mock answer, so a spec or a log can tell one from a model's. */
const MOCK_ANSWER = "[mock answer] No recording matched this request, so the scenario harness answered in place of the model.";

/**
 * VCR.py's record modes, the three this needs. `all` skips the lookup and records over any match, so
 * a retry gets a fresh draw instead of the answer its first attempt failed on (SOL-166). `mock` (SOL-208)
 * replays a recording when one matches and otherwise answers with a mock, so a run that is not meant to
 * record never calls the live model and never fails on an upstream failure. `nearest` is
 * `new_episodes` that first tries the loose keys mock mode reads: a graded build's persona prompt
 * names its own deployment, so its exact key never matches develop's recording, and each graded turn
 * would go live for an answer develop already recorded. Only
 * a conversation no run has recorded goes live, once, and is recorded.
 */
export type ReplayMode = "new_episodes" | "none" | "all" | "mock" | "nearest";

/** Whether a miss in `mode` calls the live model and records the answer, a 429 included. */
const recordsMisses = (mode: ReplayMode) => mode === "new_episodes" || mode === "nearest";

/** The status a `none`-mode miss answers with; the SDK reads it as a failed call. */
export const REPLAY_MISS_STATUS = 599;

/**
 * How long a live 429 on a miss is replayed in place of calling the model again (CUR-3982). A refusal
 * is not recorded, so with a model at its limit the same requests would miss repeatedly across
 * branches and each would go live again. Ten minutes covers a rerun of the red
 * suite; a run in the first ten minutes after the model recovers still sees the refusal.
 */
const REFUSAL_TTL_MS = 10 * 60 * 1000;

/** A recording larger than this is not stored; a streamed chat answer is a few tens of KB. */
const MAX_RECORDED_BYTES = 512 * 1024;

// The fence nonce native.ts and grounding.ts write around the latest message (Q_ + 8 hex).
const FENCE_NONCE = /\bQ_[0-9a-f]{8}\b/g;
// todayLine() in datetimeTool.ts: "Tuesday, 6 October 2026 (Asia/Seoul)". A shape we write ourselves.
const TODAY_LINE =
	/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} [A-Z][a-z]+ \d{4} \([^)]*\)/g;
// The scaffolded prompt's bare ISO date and anything else that names the calendar day.
const ISO_DATE = /\b20\d\d-\d\d-\d\d\b/g;
// A `Date.now()` stamp, which about 20 scenario specs write into the prompt to keep a chat's text
// unique on the page (SOL-181). A spec that needs a live answer says so with `@no-replay` instead.
const EPOCH_MS = /\b1\d{12}\b/g;

/** The request as it is matched: the per-turn values replaced by fixed markers. */
export function normalizeRequest(body: string): string {
	return body
		.replace(FENCE_NONCE, "Q_FENCE")
		.replace(TODAY_LINE, "TODAY")
		.replace(ISO_DATE, "DATE")
		.replace(EPOCH_MS, "EPOCH_MS");
}

/**
 * Short hashes of each part of a normalized request, logged with every miss and every recording. A
 * miss whose `ask` (the first user message) matches a recording from another run shows, by which part
 * differs, what still changes from run to run after normalizeRequest(). Empty for a body that is not a
 * chat request.
 */
export function requestParts(body: string): Record<string, string> {
	let req: Record<string, unknown>;
	try {
		req = JSON.parse(normalizeRequest(body)) as Record<string, unknown>;
	} catch {
		return {};
	}
	if (!req || typeof req !== "object" || !Array.isArray(req.messages)) return {};
	const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 8);
	const messages = req.messages as Array<{ role?: string; content?: unknown }>;
	const byRole = (roles: string[]) => messages.filter((m) => roles.includes(m.role ?? ""));
	const { messages: _m, tools, ...params } = req;
	return {
		ask: h(byRole(["user"])[0]?.content),
		system: h(byRole(["system", "developer"])),
		users: h(byRole(["user"])),
		replies: h(byRole(["assistant", "tool"])),
		// One hash per reply message, so a miss names which message differed (SOL-217).
		reply_each: byRole(["assistant", "tool"]).map(h).join(","),
		tools: h(tools),
		params: h(params),
		turns: String(messages.length),
	};
}

/**
 * The body as it is keyed: its `model` field set to `appModelId`, the app's own id for the model, when
 * the wire carries another name. MISTRAL_CHAT_MODEL_MAP maps our id to a host's (Medium 3.5 goes out as
 * `mistralai/mistral-medium-3-5` on the router), and that map is env, so a pin change would
 * re-key every Medium recording with no code change, and every PR preview built after it would answer
 * Medium with a mock. A body whose `model` is already `appModelId`, or that is not JSON, is returned as is,
 * so every recording keyed before this still matches.
 *  @internal exported for its unit tests */
export function keyedBody(body: string, appModelId?: string): string {
	if (!appModelId || !body) return body;
	let req: unknown;
	try {
		req = JSON.parse(body);
	} catch {
		return body;
	}
	if (!req || typeof req !== "object" || Array.isArray(req)) return body;
	const model = (req as { model?: unknown }).model;
	if (typeof model !== "string" || model === appModelId) return body;
	return JSON.stringify({ ...(req as Record<string, unknown>), model: appModelId });
}

export function replayKey(path: string, body: string): string {
	return createHash("sha256").update(`${path}\n${normalizeRequest(body)}`).digest("hex").slice(0, 32);
}

/**
 * The key with the system and developer messages left out, or null for a body that is not a chat
 * request. The persona prompt carries deployment facts (screening, account, offered models) that differ
 * between develop and a PR preview, so an exact key recorded on develop never matches on a PR, whose
 * request differs from develop's recording in `system` alone (SOL-208). Mock mode
 * reads it after an exact miss, where the alternative is a canned answer; a live mode never does, so a
 * PR that changes the prompt still records against the model.
 *  @internal exported for its unit tests */
export function looseReplayKey(path: string, body: string): string | null {
	const req = chatRequest(body);
	if (!req) return null;
	const messages = (req.messages as LooseMessage[]).filter((m) => m.role !== "system" && m.role !== "developer");
	return hashLoose(path, { ...req, messages });
}

/**
 * The loose key with tool rounds normalized too (SOL-217), or null for a body that is not a chat
 * request. Mock mode reads it after `looseReplayKey` misses. It is a second key, never a replacement:
 * it reduces `tools` to names, so it differs from `looseReplayKey` for every request that offers tools,
 * and replacing the first key with it would orphan every recording develop had made.
 *  @internal exported for its unit tests */
export function toolLooseReplayKey(path: string, body: string): string | null {
	const req = chatRequest(body);
	if (!req) return null;
	const messages = looseMessages(req.messages as LooseMessage[]);
	const tools = Array.isArray(req.tools) ? toolNames(req.tools) : req.tools;
	return hashLoose(path, { ...req, messages, tools });
}

/** Every loose key for a request, in the order mock mode tries them, without repeats. */
function looseReplayKeys(path: string, body: string): string[] {
	const keys = [looseReplayKey(path, body), toolLooseReplayKey(path, body)];
	return keys.filter((k, i): k is string => k !== null && keys.indexOf(k) === i);
}

function chatRequest(body: string): (Record<string, unknown> & { messages: unknown[] }) | null {
	let req: Record<string, unknown>;
	try {
		req = JSON.parse(normalizeRequest(body)) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!req || typeof req !== "object" || !Array.isArray(req.messages)) return null;
	return req as Record<string, unknown> & { messages: unknown[] };
}

function hashLoose(path: string, req: Record<string, unknown>): string {
	return createHash("sha256").update(`loose\n${path}\n${JSON.stringify(req)}`).digest("hex").slice(0, 32);
}

type LooseMessage = {
	role?: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id?: string; [k: string]: unknown }>;
};

/** Stands in for every tool result in the loose key. */
const LOOSE_TOOL_RESULT = "[tool result]";

/**
 * The conversation as the loose key sees it. A tool-using turn never matched develop's recording on a
 * PR (SOL-217): the requests differ in `replies` alone. Three parts of a
 * reply differ per run without changing what the model is asked: the provider's `tool_calls` ids, the
 * tool output (a live search returns different pages each time), and the system and developer
 * messages SOL-208 already dropped. Ids become positional `call_N` on both the call and its result,
 * so a renumbering keeps the pairing; every tool result becomes one marker.
 */
function looseMessages(messages: LooseMessage[]): LooseMessage[] {
	const ids = new Map<string, string>();
	const rename = (id: string | undefined) => {
		if (id === undefined) return id;
		let renamed = ids.get(id);
		if (renamed === undefined) {
			renamed = `call_${ids.size}`;
			ids.set(id, renamed);
		}
		return renamed;
	};
	return messages
		.filter((m) => m.role !== "system" && m.role !== "developer")
		.map((m) => {
			if (m.role === "tool") return { ...m, tool_call_id: rename(m.tool_call_id), content: LOOSE_TOOL_RESULT };
			if (Array.isArray(m.tool_calls)) return { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, id: rename(c.id) })) };
			return m;
		});
}

/** Tool schemas by name, sorted: a description carries deployment facts the way the persona prompt does. */
function toolNames(tools: unknown[]): string[] {
	return tools
		.map((t) => {
			const tool = t as { name?: unknown; function?: { name?: unknown } };
			return String(tool?.function?.name ?? tool?.name ?? "");
		})
		.sort();
}

/** Exported for the module's own spec, which adds a recording to replay. */
export const cassettes: Map<string, Cassette> = new Map(
	Object.values(
		import.meta.glob<Cassette>("./cassettes/*.json", { eager: true, import: "default" })
	).map((c) => [c.requestHash, c])
);

/** A response the SDK reads as a stream, released in small pieces as a live one is. */
function cassetteResponse(c: Cassette): Response {
	const bytes = new TextEncoder().encode(c.body);
	const piece = 256;
	let at = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.subarray(at, at + piece));
			at += piece;
		},
	});
	// Marked so a replayed turn's provenance is never read as a live reading of where it ran.
	return new Response(body, {
		status: c.status,
		headers: { ...c.headers, [REPLAY_HEADER]: c.recordedAt },
	});
}

/** open-web search's vendor. Its calls replay like a model's, so CI stops spending credits. (SOL-219) */
const FIRECRAWL_HOST = "api.firecrawl.dev";

/**
 * A Firecrawl answer with nothing in it: a search with no results, a scrape with no page. The search
 * code treats both as a thin web, the way it treats a live search that found nothing, so a scenario
 * run with no recording grounds on Wikipedia and OpenAlex alone and spends no Firecrawl credit.
 */
function firecrawlMock(path: string): Response {
	const data = path.endsWith("/search") ? { web: [] } : { markdown: "", metadata: {} };
	return new Response(JSON.stringify({ success: true, data }), {
		status: 200,
		headers: { "content-type": "application/json", [MOCK_HEADER]: "1" },
	});
}

type MockRequest = {
	model?: unknown;
	stream?: unknown;
	tool_choice?: unknown;
	tools?: unknown;
	messages?: unknown;
	response_format?: { type?: unknown };
};

/** The last user message's text, for a mock tool call's arguments. */
function lastUserText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown };
		if (m?.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content))
			return m.content
				.map((p: { type?: unknown; text?: unknown }) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
				.join(" ")
				.trim();
		return "";
	}
	return "";
}

/**
 * A request that forces one named tool it offers gets a mock call to that tool, so the turn
 * runs the tool (whose own vendor is mocked too, e.g. Firecrawl) and its next round, which no longer
 * forces anything, gets the mock answer. Each required string argument is the last user message; any
 * other required argument has no generic value, so such a tool gets no mock call. (CUR-4083)
 */
function mockToolCall(req: MockRequest): { name: string; arguments: string } | null {
	const choice = req.tool_choice as { type?: unknown; function?: { name?: unknown } } | undefined;
	const name = choice?.type === "function" ? choice.function?.name : undefined;
	if (typeof name !== "string" || !Array.isArray(req.tools)) return null;
	const tool = (req.tools as { function?: { name?: unknown; parameters?: unknown } }[]).find(
		(t) => t?.function?.name === name
	);
	if (!tool) return null;
	const params = (tool.function?.parameters ?? {}) as {
		properties?: Record<string, { type?: unknown }>;
		required?: unknown;
	};
	const args: Record<string, string> = {};
	const text = lastUserText(req.messages);
	for (const key of Array.isArray(params.required) ? params.required : []) {
		if (typeof key !== "string" || params.properties?.[key]?.type !== "string") return null;
		args[key] = text;
	}
	return { name, arguments: JSON.stringify(args) };
}

/**
 * A deterministic answer in the shape the request asked for, or null when no generic answer can be
 * right: a call that is not a chat completion (Clef), or one that forces a JSON schema, `required`, or a
 * tool mockToolCall cannot fill, whose caller would read our text as a malformed answer rather than a
 * missing one.
 */
function mockResponse(path: string, body: string, host = ""): Response | null {
	if (host === FIRECRAWL_HOST) return firecrawlMock(path);
	// eslint-disable-next-line chat-paths/no-chat-path-literal -- the OpenAI API path, not ours
	if (!path.endsWith("/chat/completions")) return null;
	let req: MockRequest;
	try {
		req = JSON.parse(body);
	} catch {
		return null;
	}
	const forcesTool = req.tool_choice !== undefined && req.tool_choice !== "auto" && req.tool_choice !== "none";
	const call = forcesTool ? mockToolCall(req) : null;
	if (forcesTool && !call) return null;
	if (req.response_format && req.response_format.type !== "text") return null;
	const model = typeof req.model === "string" ? req.model : "mock";
	const base = { id: "mock", created: 0, model };
	const headers = { [MOCK_HEADER]: "1" };
	const toolCall = call && { id: "mock_call_0", type: "function", function: call };
	if (req.stream !== true) {
		const message = toolCall
			? { role: "assistant", content: null, tool_calls: [toolCall] }
			: { role: "assistant", content: MOCK_ANSWER };
		const completion = {
			...base,
			object: "chat.completion",
			choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		};
		return new Response(JSON.stringify(completion), { status: 200, headers: { ...headers, "content-type": "application/json" } });
	}
	const chunk = (delta: Record<string, unknown>, finish: string | null) =>
		`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	if (toolCall) {
		const sse =
			chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, ...toolCall }] }, null) +
			chunk({}, "tool_calls") +
			"data: [DONE]\n\n";
		return cassetteResponse({ requestHash: "mock", path, status: 200, headers: { ...headers, "content-type": "text/event-stream" }, body: sse, recordedAt: "mock" });
	}
	// One chunk per word, the way a model streams: a fault that counts streamed tokens
	// (`stream_truncates_midway` cuts after 12) never fires on a one-chunk answer.
	const words = MOCK_ANSWER.match(/\S+\s*/g) ?? [MOCK_ANSWER];
	const sse =
		chunk({ role: "assistant", content: "" }, null) +
		words.map((w) => chunk({ content: w }, null)).join("") +
		chunk({}, "stop") +
		"data: [DONE]\n\n";
	return cassetteResponse({ requestHash: "mock", path, status: 200, headers: { ...headers, "content-type": "text/event-stream" }, body: sse, recordedAt: "mock" });
}

function urlOf(url: string | URL | Request): URL {
	return new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
}

/**
 * Whether a response body is a whole answer: a stream that reached a finish reason or `[DONE]`, or a
 * JSON body that parses. A stream the upstream closed mid-answer is neither, and is never recorded,
 * since another branch would replay it as a complete answer (SOL-180).
 */
function isFinished(text: string, contentType: string): boolean {
	if (/event-stream/i.test(contentType)) return /"finish_reason"\s*:\s*"|data:\s*\[DONE\]/.test(text);
	// arXiv answers Atom XML (SOL-262), which is whole when its root element has closed.
	if (/xml/i.test(contentType)) return /<\/[A-Za-z:]+>\s*$/.test(text);
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Answer `url`/`init` from a recording when one matches; otherwise call `live` and record what it
 * returns. The live response is handed back at once and recorded as its body drains, so a miss is as
 * fast as an unreplayed call.
 */
export async function replayOrRecord(
	url: string | URL | Request,
	init: RequestInit | undefined,
	/** Makes the live call with the `init` it is handed, which on a miss carries no abort signal. */
	live: (init: RequestInit | undefined) => Promise<Response>,
	log: Record<string, unknown> = {},
	mode: ReplayMode = "new_episodes",
	/**
	 * A request that ran live before scenario runs replayed it (the open-web engines, the
	 * reranker, the embedder) still runs live on a mock-mode miss, unrecorded, until develop's push run
	 * has recorded it. A model call never does. (SOL-262)
	 */
	{
		liveOnMiss = false,
		refreshDue,
		appModelId,
	}: {
		liveOnMiss?: boolean;
		refreshDue?: (recordedAt: string, key: string) => boolean;
		/** The app's id for the model this call asks for, keyed in place of the wire id (keyedBody). */
		appModelId?: string;
	} = {}
): Promise<Response> {
	const { pathname: path, host, search } = urlOf(url);
	// Only the key reads this; the live call still sends `init` exactly as the caller built it.
	const sentBody = typeof init?.body === "string" ? init.body : "";
	const body = keyedBody(sentBody, appModelId);
	// Recordings made before appModelId are keyed on the wire id, and a mock-mode PR run never records,
	// so each lookup also reads the wire-id key until develop's runs have re-recorded under ours.
	const legacyBody = body === sentBody ? null : sentBody;
	// A GET carries its request in the query string (SOL-262: the open-web engines), so it keys on that.
	// A model call with a body keys on the path alone, as every recording made before SOL-262 did.
	// A liveOnMiss request (embed, rerank, engines) keys on its host too: the search-intent and
	// self-identity embedders post the same body to "/" on two hosts, and one shared recording answered
	// both with one model's vector, so the French identity question searched the web (SOL-269).
	const keyPath = (liveOnMiss ? host : "") + (body ? path : path + search);
	const key = replayKey(keyPath, body);
	const startedAt = Date.now();
	let found: { cassette: Cassette; scope: string } | null = null;
	try {
		if (mode !== "all") found = await lookup(key, undefined, host);
		if (mode !== "all" && !found && legacyBody) {
			found = await lookup(replayKey(keyPath, legacyBody), undefined, host);
			// Copied under our key, so the next lookup hits on the first read.
			if (found && recordsMisses(mode)) void record({ ...found.cassette, requestHash: key }).catch(() => {});
		}
	} catch (err) {
		// An unreachable store is a miss, logged as its own line so a run of them is not read as new prompts.
		logger.error({ ...log, key, err: String(err) }, "[replay] store unreachable or unset, treating as a miss");
	}
	// `refreshDue` marks a good recording due for a refresh, so the request goes live and
	// records over it; one it does not mark replays. The guard's `@real-screen` leg uses it to refresh
	// each verdict off-peak and spread out, instead of on every develop run. (SOL-267)
	const stale = (c: Cassette | undefined) =>
		Boolean(
			c &&
				!c.refusedUntil &&
				((refreshDue && refreshDue(c.recordedAt, key)) || (recordsMisses(mode) && lacksProvider(c)))
		);
	let staleAt: string | undefined;
	if (found && stale(found.cassette)) {
		staleAt = found.cassette.recordedAt;
		found = null;
	}
	// A bundled good cassette outranks a refusal from the store, as every good recording does (CUR-3996).
	let bundled = (found && !found.cassette.refusedUntil) || mode === "all" ? undefined : (cassettes.get(key) ?? (legacyBody ? cassettes.get(replayKey(keyPath, legacyBody)) : undefined));
	if (bundled && stale(bundled)) {
		staleAt ??= bundled.recordedAt;
		bundled = undefined;
	}
	if (bundled && found) found = null;
	if (found || bundled) {
		const from = found?.scope ?? "bundle";
		if (found?.cassette.refusedUntil) {
			logger.warn(
				{ ...log, key, path, from, refusedUntil: found.cassette.refusedUntil, lookupMs: Date.now() - startedAt },
				"[replay] refusal: the model answered 429 for this request recently, replaying it, no model call"
			);
		} else {
			logger.info({ ...log, key, path, from, lookupMs: Date.now() - startedAt }, "[replay] hit: answered from a recording, no model call");
			// A recording without the loose key gets one the first time a recording run reads
			// it, so develop's push run fills in what PR mock runs fall back to.
			if (recordsMisses(mode) && found) {
				for (const loose of looseReplayKeys(path, body)) {
					void record({ ...found.cassette, requestHash: loose }).catch((err) => logger.warn({ key, err: String(err) }, "[replay] loose backfill failed"));
				}
			}
		}
		return cassetteResponse(found?.cassette ?? bundled!);
	}
	if (mode === "mock" || mode === "nearest") {
		let loose: string | null = null;
		let near: { cassette: Cassette; scope: string } | null = null;
		try {
			for (const k of [...looseReplayKeys(path, body), ...(legacyBody ? looseReplayKeys(path, legacyBody) : [])]) {
				near = await lookup(k, undefined, host);
				loose = k;
				if (near) break;
			}
		} catch (err) {
			logger.error({ ...log, key, err: String(err) }, "[replay] store unreachable or unset, treating as a miss");
		}
		if (near && !near.cassette.refusedUntil) {
			// `parts` ties a hit to its ask, and `matched` says which loose key found it, so a
			// spec's tool turns can be shown hitting rather than inferred from an absence of mocks. (SOL-217)
			const matched = loose === looseReplayKey(path, body) ? "plain" : "tool";
			logger.info(
				{ ...log, key, loose, matched, path, parts: requestParts(body), from: near.scope, lookupMs: Date.now() - startedAt },
				"[replay] hit on the conversation without its system prompt: answered from a recording, no model call"
			);
			return cassetteResponse(near.cassette);
		}
	}
	if (mode === "mock") {
		const mocked = mockResponse(path, body, host);
		if (mocked) {
			logger.info({ ...log, key, path, parts: requestParts(body) }, "[replay] mock: no recording, answered with a mock, no model call");
			return mocked;
		}
	}
	if (mode === "mock" && liveOnMiss) {
		logger.warn(
			{ ...log, key, host, path, lookupMs: Date.now() - startedAt },
			"[replay] miss in mock mode: no recording yet, calling live without recording it"
		);
		return live(init);
	}
	if (mode === "none" || mode === "mock") {
		logger.error({ ...log, key, path }, `[replay] miss in ${mode} mode: no recording, and this run makes no live model call`);
		return new Response(JSON.stringify({ error: { message: `[replay] none mode: no recording for ${key}` } }), {
			status: REPLAY_MISS_STATUS,
			headers: { "content-type": "application/json" },
		});
	}
	const parts = requestParts(body);
	logger.warn(
		{ ...log, key, path, mode, parts, lookupMs: Date.now() - startedAt, ...(staleAt ? { staleAt } : {}) },
		mode === "all"
			? "[replay] all mode: skipping any recording, calling the live model and recording over it"
			: staleAt
				? "[replay] stale: the recording is due for a refresh, calling the live model and recording over it"
				: "[replay] miss: no recording for this request, calling the live model and recording it"
	);
	// The live call leaves without the caller's abort signal, and the caller is tied to that signal here
	// instead: an abort before the headers rejects the caller at once (a failover deadline still fires),
	// and one after them ends the caller's half of the stream. Either way the recording half drains to
	// the model's own end, so a spec that presses Stop still leaves a recording for the next run.
	const signal = init?.signal ?? undefined;
	const settled = live(signal ? { ...init, signal: undefined } : init).then((response) =>
		recordLive(response, { key, path, host, body, parts, mode, signal })
	);
	if (!signal) return settled;
	return new Promise<Response>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Hands `response` back to the caller (its stream ended by `signal`) while recording its whole body. */
async function recordLive(
	response: Response,
	{ key, path, host, body, parts, mode, signal }: { key: string; path: string; host: string; body: string; parts: Record<string, string>; mode: ReplayMode; signal?: AbortSignal }
): Promise<Response> {
	// A 429 is recorded with an expiry (REFUSAL_TTL_MS), so reruns stop spending a limit that is already
	// spent; recorded forever it would refuse every later run. `all` mode records over a good answer, so
	// it never records a refusal.
	if (response.status === 429 && recordsMisses(mode)) return recordRefusal(response, key, path, host);
	if (!response.ok || !response.body) return response;
	const [toCaller, toRecord] = response.body.tee();
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => {
		if (KEPT_HEADER.test(k)) headers[k] = v;
	});
	void new Response(toRecord)
		.text()
		.then(async (text) => {
			if (text.length > MAX_RECORDED_BYTES) {
				logger.warn({ key, bytes: text.length }, "[replay] response too large to record");
				return;
			}
			if (!isFinished(text, response.headers.get("content-type") ?? "")) {
				logger.warn({ key, bytes: text.length }, "[replay] answer ended before it finished, not recorded");
				return;
			}
			const cassette = { requestHash: key, path, host, status: response.status, headers, body: text, recordedAt: new Date().toISOString() };
			await record(cassette);
			const loose = looseReplayKeys(path, body);
			for (const k of loose) await record({ ...cassette, requestHash: k });
			logger.info({ key, loose, bytes: text.length, parts }, "[replay] recorded");
		})
		.catch((err) => logger.warn({ key, err: String(err) }, "[replay] recording failed"));
	const shown = signal ? toCaller.pipeThrough(new TransformStream(), { signal }) : toCaller;
	return new Response(shown, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * How long a 429 is replayed: the provider's own `Retry-After` when it names a shorter wait, so a
 * per-minute blip clears for the SDK's retry and the next run alike; REFUSAL_TTL_MS otherwise.
 */
function refusalTtl(retryAfter: string | null, now: number): number {
	if (!retryAfter) return REFUSAL_TTL_MS;
	const seconds = Number(retryAfter);
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
	return Number.isFinite(ms) ? Math.min(REFUSAL_TTL_MS, Math.max(0, ms)) : REFUSAL_TTL_MS;
}

/** Records a 429 to be replayed until refusalTtl from now, and hands back the same response. */
async function recordRefusal(response: Response, key: string, path: string, host: string): Promise<Response> {
	const text = await response.text();
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => {
		if (KEPT_HEADER.test(k)) headers[k] = v;
	});
	const now = Date.now();
	const refusedUntil = new Date(now + refusalTtl(response.headers.get("retry-after"), now)).toISOString();
	// Awaited, so the SDK's own retry of this call a moment later finds it.
	try {
		await record({ requestHash: key, path, host, status: 429, headers, body: text.slice(0, MAX_RECORDED_BYTES), recordedAt: new Date(now).toISOString(), refusedUntil });
		logger.warn({ key, refusedUntil }, "[replay] recorded a 429, replayed in place of a live call until it expires");
	} catch (err) {
		logger.warn({ key, err: String(err) }, "[replay] recording a 429 failed");
	}
	return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}
