// Folkways adapter — the observe pipeline and the helpers both chat routes share.
//
// Moved out of v1/chat/completions/+server.ts (CUR-3186) so the Mistral route
// (mistral/v1/chat/completions/+server.ts) runs the SAME observe code — prompts report, per-turn
// trace, safety report — rather than a copy. A +server.ts may export only its handlers, so shared
// code has to live in a plain module. Module-level memos (last reported prompt hash, last safety
// signature) live here too, so both routes share one per-instance memo.

import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
// Static, not dynamic: PUBLIC_COMMIT_SHA is set by svelte.config.js's own top-level code
// (`process.env.PUBLIC_COMMIT_SHA ??= ...`, from VERCEL_GIT_COMMIT_SHA or `git rev-parse HEAD`)
// while the BUILD is being configured, not by anything present in the running Vercel function's
// actual environment. $env/dynamic/public reads real runtime process.env, which never had this
// var set on it, so the commit would read `None`. $env/static/public instead inlines
// whatever process.env held at BUILD time, which is exactly when svelte.config.js set it, so this
// is always populated. See the folkways-adapter README for why there's no `branch` here: nothing
// in this host exposes one at runtime.
import { PUBLIC_COMMIT_SHA } from '$env/static/public';
import { safetySnapshot, safetySignature, type SafetySnapshot } from './safetySnapshot';
import {
	loadStablePromptSegments,
	stablePromptHash,
	resolveModelAllowlist,
	resolveModelParameters,
	type PromptReportSegment
} from './promptLoader';
import { detectLayers } from './layerDetection';
import { buildObserveTracePayload } from './observeTrace';
import { getTuning } from '$lib/chat/server/tuning';
import { defaultModel } from '$lib/chat/server/models';
import { runInBackground } from '$lib/chat/server/vercelBackground';
import { passthroughResponseHeaders } from './passthroughHeaders';
import { json } from './json';
import { hfBillToHeader } from '$lib/chat/server/hfBillTo';

export const ADAPTER_ID = 'openai-gateway';
export const ADAPTER_VERSION = '1';

type ChatMessage = { role: string; content: unknown };
export type ChatRequest = { model?: string; messages: ChatMessage[]; [k: string]: unknown };

export const cfg = () => ({
	folkwaysUrl: (env.FOLKWAYS_URL ?? 'http://localhost:4600').replace(/\/$/, ''),
	folkwaysToken: env.FOLKWAYS_TOKEN_GATEWAY ?? 'dev-gateway-token',
	upstreamBaseUrl: (env.FOLKWAYS_UPSTREAM_BASE_URL ?? 'https://router.huggingface.co/v1').replace(
		/\/$/,
		''
	),
	upstreamApiKey: env.FOLKWAYS_UPSTREAM_API_KEY || env.HF_TOKEN || env.OPENAI_API_KEY || '',
	// The HF Inference Providers router bills to an org via this header. Without it a valid
	// read-only token 403s ("insufficient permissions to call Inference Providers"). Falls back
	// to the host's existing HF_BILL_TO so no new secret is needed on the HF router lane.
	upstreamBillTo: env.FOLKWAYS_UPSTREAM_BILL_TO || env.HF_BILL_TO || '',
	context: {
		community: env.FOLKWAYS_COMMUNITY ?? 'pottsboro-library',
		deployment: env.FOLKWAYS_DEPLOYMENT ?? 'public-chat',
		environment: env.FOLKWAYS_ENVIRONMENT ?? 'development'
	}
});

/**
 * One authorised JSON POST to the Folkways control plane, bounded by `timeoutMs`. Every adapter call
 * to Folkways (host reports, both trace kinds, resolve) goes through here, so the auth header and
 * timeout policy live in one place. Callers own their error handling and log wording.
 */
export function postToFolkways(
	c: ReturnType<typeof cfg>,
	path: string,
	payload: unknown,
	timeoutMs = 2000
): Promise<Response> {
	return fetch(`${c.folkwaysUrl}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${c.folkwaysToken}`, 'content-type': 'application/json' },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(timeoutMs)
	});
}

// Shared POST /v1/host-reports call for both report kinds. Callers keep their own change-memo
// and error-logging wording.
function postHostReport(
	c: ReturnType<typeof cfg>,
	context: ReturnType<typeof cfg>['context'],
	kind: string,
	report: unknown
): Promise<Response> {
	return postToFolkways(c, '/v1/host-reports', {
		report_version: '1',
		context,
		adapter_id: ADAPTER_ID,
		kind,
		report
	});
}

// Push the safety snapshot to Folkways as a host report, but only when it changed since the
// last push from this instance (first request after a cold start, then on any rules/detector
// change). Bounded to 2s; never fails a chat request.
let lastSafetySignature: string | null = null;

export async function reportSafety(
	context: ReturnType<typeof cfg>['context'],
	safety: SafetySnapshot
): Promise<void> {
	const signature = safetySignature(safety);
	if (signature === lastSafetySignature) return;
	const c = cfg();
	try {
		const res = await postHostReport(c, context, 'safety', safety);
		if (res.ok) lastSafetySignature = signature;
		else console.error(`[folkways-adapter] safety report returned ${res.status}`);
	} catch (err) {
		console.error(`[folkways-adapter] safety report failed: ${(err as Error).message}`);
	}
}

// The snapshot is a view over host state; if it ever throws, the chat request still serves and
// the trace records that the safety facts were unavailable rather than inventing them.
export async function currentSafety(): Promise<SafetySnapshot | null> {
	try {
		return await safetySnapshot();
	} catch (err) {
		console.error(`[folkways-adapter] safety snapshot failed: ${(err as Error).message}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Observe mode. No resolve call, no prompt replacement, no model override —
// the request goes upstream exactly as the host sent it. Two content-free reports go to
// Folkways: the stable prompts (only when their hash changed) and a per-turn trace.

// Last stable-prompt hash this process reported, so a POST /v1/host-reports only fires when the
// hash actually changed, not on every single chat request.
let lastStablePromptHash: string | null = null;

async function postPromptsReport(
	segments: PromptReportSegment[],
	hash: string,
	hostModelId: string,
	modelAllowlist: string[],
	modelParameters: Record<string, unknown>
): Promise<void> {
	const c = cfg();
	try {
		const res = await postHostReport(c, c.context, 'prompts', {
			host_model_id: hostModelId,
			prompt_hash: hash,
			// Commit: build-time PUBLIC_COMMIT_SHA — see the import comment above for why static,
			// not dynamic. Still optional: a non-Vercel/no-git checkout can leave it unset.
			...(PUBLIC_COMMIT_SHA ? { commit: PUBLIC_COMMIT_SHA } : {}),
			reported_at: new Date().toISOString(),
			segments,
			model_allowlist: modelAllowlist,
			model_parameters: modelParameters
		});
		if (res.ok) lastStablePromptHash = hash;
		else console.error(`[folkways-adapter] prompts report returned ${res.status}`);
	} catch (err) {
		console.error(`[folkways-adapter] prompts report failed: ${(err as Error).message}`);
	}
}

// Fire-and-forget-bounded, like postTrace above, but for observe mode. The payload itself is
// built by buildObserveTracePayload (../../../observeTrace.ts) — pulled out so the exact shape
// sent here is what observeTrace.spec.ts validates against the strict trace schema.
async function postObserveTrace(fields: {
	servedModel: string;
	promptHash: string;
	layers: ReturnType<typeof detectLayers>;
	status: string;
	requestedAt: string;
	respondedAt: string;
	durationMs: number;
	detail: Record<string, unknown>;
}): Promise<void> {
	const c = cfg();
	try {
		const res = await postToFolkways(
			c,
			'/v1/traces',
			buildObserveTracePayload({
				context: c.context,
				adapterId: ADAPTER_ID,
				servedModel: fields.servedModel,
				requestId: crypto.randomUUID(),
				detail: fields.detail,
				promptHash: fields.promptHash,
				layers: fields.layers,
				status: fields.status,
				requestedAt: fields.requestedAt,
				respondedAt: fields.respondedAt,
				durationMs: fields.durationMs
			})
		);
		if (!res.ok) console.error(`[folkways-adapter] observe trace returned ${res.status}`);
		// The positive record that a trace landed: Folkways' trace list needs a console login, and a
		// missing error line says nothing about whether the POST ran (CUR-3186).
		else
			console.info(
				`[folkways-adapter] observe trace posted ${res.status} lane=${String(fields.detail.lane ?? 'gateway')} model=${fields.servedModel}`
			);
	} catch (err) {
		console.error(`[folkways-adapter] observe trace failed: ${(err as Error).message}`);
	}
}

// Read an incoming chat.completions body once, keeping the exact bytes the caller sent alongside the
// parsed copy: the Mistral route forwards `raw` untouched, and the trace reads `body`.
async function readChatRequest(
	request: Request
): Promise<{ body: ChatRequest; raw: string } | null> {
	const raw = await request.text().catch(() => null);
	if (raw === null) return null;
	let body: ChatRequest | null;
	try {
		body = JSON.parse(raw) as ChatRequest | null;
	} catch {
		return null;
	}
	if (!body?.messages) return null;
	return { body, raw };
}

// Parse an incoming chat.completions body; both modes reject a bad one identically.
export async function parseChatRequest(request: Request): Promise<ChatRequest | null> {
	return (await readChatRequest(request))?.body ?? null;
}

// Forward the (possibly rewritten) request upstream. Same call in both modes.
export async function forwardUpstream(
	c: ReturnType<typeof cfg>,
	payload: ChatRequest
): Promise<Response> {
	return fetch(`${c.upstreamBaseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(c.upstreamApiKey ? { authorization: `Bearer ${c.upstreamApiKey}` } : {}),
			...hfBillToHeader(c.upstreamBaseUrl, { ownLane: false }, c.upstreamBillTo)
		},
		body: JSON.stringify(payload)
	});
}

/** Sends one chat.completions request upstream: the parsed body, and the exact bytes it came from. */
type ObserveForward = (body: ChatRequest, raw: string) => Promise<Response>;

/**
 * Observe one turn: report stable prompts, pass the request upstream, trace it, return the
 * upstream response with its body untouched.
 *
 * @remarks
 * `forward` picks the upstream. The default is the gateway lane (`forwardUpstream`, which
 * re-serializes the parsed body, as it always has); the Mistral route passes its own. `detail` adds
 * fields to the trace's loose `detail` record, e.g. which lane served.
 */
export async function handleObserve(
	request: Request,
	opts: { forward?: ObserveForward; detail?: Record<string, unknown> } = {}
): Promise<Response> {
	const parsed = await readChatRequest(request);
	if (!parsed) return json(400, { error: { message: 'invalid chat.completions request' } });
	const { body, raw } = parsed;
	const forward: ObserveForward = opts.forward ?? ((b) => forwardUpstream(c, b));

	const c = cfg();

	// Step 1: stable prompts, reported only when their hash changed since this process's last
	// report. Run via runInBackground (vercelBackground.ts) rather than a floating promise: on
	// Vercel the function is frozen the instant the response returns, so an un-awaited promise here
	// would be silently dropped (or thaw inside a later, unrelated request) instead of completing.
	// runInBackground schedules this onto the request's waitUntil when one exists (the common
	// Vercel case) and returns immediately — zero added latency, matching the zero-added-latency requirement. On Vercel with no waitUntil it awaits inline instead (correct but slower); outside
	// Vercel (dev/tests) the work is a plain floating promise, which is safe there because the
	// process stays alive. A loader/report failure must never block or break the chat request —
	// postPromptsReport already swallows its own errors, and only updates lastStablePromptHash on
	// a successful POST, so a failed report is simply retried on the next request.
	await runInBackground(
		(async () => {
			try {
				const segments = await loadStablePromptSegments();
				const hash = stablePromptHash(segments);
				if (hash !== lastStablePromptHash) {
					const hostModelId = defaultModel?.id ?? defaultModel?.name ?? 'unknown';
					const modelAllowlist = resolveModelAllowlist(hostModelId);
					const modelParameters = await resolveModelParameters();
					await postPromptsReport(segments, hash, hostModelId, modelAllowlist, modelParameters);
				}
			} catch (err) {
				console.error(`[folkways-adapter] stable-prompt load failed: ${(err as Error).message}`);
			}
		})()
	);

	// persona_override is an exact per-turn fact (not text-detected — see layerDetection.ts's
	// header note): it's the same tuning.persona check textGeneration/index.ts itself makes
	// before calling buildPersonaPrompt(). getTuning() is cheap (in-process ~20s cache).
	let personaOverrideActive = false;
	try {
		personaOverrideActive = Boolean((await getTuning()).persona?.trim());
	} catch (err) {
		console.error(`[folkways-adapter] tuning read failed: ${(err as Error).message}`);
	}

	const systemText =
		body.messages.find((m) => m.role === 'system' && typeof m.content === 'string')?.content ?? '';
	const layers = detectLayers(
		typeof systemText === 'string' ? systemText : '',
		personaOverrideActive
	);
	const turnPromptHash = createHash('sha256')
		.update(typeof systemText === 'string' ? systemText : '')
		.digest('hex');

	// Step 3: pass the request through UNCHANGED — no resolve, no prompt replacement, no model
	// override. This is the entire difference from resolve mode's applyBundle() step.
	const requestedAt = new Date();
	const upstream = await forward(body, raw);
	const respondedAt = new Date();

	// Step 4 + observe's safety report: pushed to runInBackground after the upstream response has
	// arrived, but not awaited-to-completion here — like Step 1 above, this must survive a Vercel
	// freeze rather than float. Both helpers already swallow their own errors (fetch failures and
	// non-2xx Folkways responses are logged, by status code only, inside
	// postObserveTrace/reportSafety), so runInBackground's own `.catch(() => {})` is just a
	// defensive backstop against an unhandled rejection.
	const safety = await currentSafety();
	await runInBackground(
		postObserveTrace({
			servedModel: body.model ?? 'unknown',
			promptHash: turnPromptHash,
			layers,
			status: upstream.ok ? 'ok' : 'error',
			requestedAt: requestedAt.toISOString(),
			respondedAt: respondedAt.toISOString(),
			durationMs: respondedAt.getTime() - requestedAt.getTime(),
			detail: {
				...opts.detail,
				mode: 'observe',
				stream: Boolean(body.stream),
				upstream_status: upstream.status,
				safety_rules_hash: safety?.rules_hash ?? null,
				safety_detector: safety?.detector ?? null,
				safety_rules_json_enforced: safety?.rules_json_enforced ?? null,
				safety_output_moderation: safety?.output_moderation ?? null
			}
		})
	);
	if (safety) await runInBackground(reportSafety(c.context, safety));

	return new Response(upstream.body, {
		status: upstream.status,
		headers: passthroughResponseHeaders(upstream.headers)
	});
}
