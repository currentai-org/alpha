// Folkways adapter — thin by design.
//
// This route is an OpenAI-compatible endpoint that the chat stack points a
// model's `baseURL` at (via a MODELS env override — no code change), gated by
// FOLKWAYS_ENABLED (../../flag.ts) — the route 404s when the flag is off.
//
// Two modes, selected by FOLKWAYS_MODE (../../flag.ts):
//
// resolve (default, pre-existing behavior) — per request it:
//   1. resolves the active behavior bundle from the Folkways control plane
//   2. replaces the host system message with the community prompt slots
//   3. forces the community-approved model (hard control + allowlist)
//   4. forwards to the upstream provider, streaming straight through
//   5. posts a trace back to Folkways (stamped with the host's safety rules hash)
//   6. pushes a safety host-report to Folkways whenever that snapshot changes
//
// observe (FOLKWAYS_MODE=observe) — per request it:
//   1. loads the stable prompts (../../promptLoader.ts) and, only when their hash changed since
//      the last report from this process, POSTs a `prompts` host report — segments plus the live
//      model_allowlist and resolved model_parameters (promptLoader.ts's resolveModelAllowlist /
//      resolveModelParameters) and, when available, the build commit
//   2. passes the request to the real provider UNCHANGED — no resolve call, no prompt
//      replacement, no model override
//   3. sends a trace with the per-turn system-message hash, the detected layer flags
//      (../../layerDetection.ts), status and timing — no bundle, no release
//   4. pushes the safety host-report exactly as resolve mode does (unchanged)
//
// It selects nothing, resolves no conflicts, and imports nothing from Folkways
// core. Its chat-lib reads are the safety snapshot (../../safetySnapshot.ts) and, in observe
// mode only, the stable-prompt loader (../../promptLoader.ts) — both read-only views so Folkways
// can show host state. No gate is touched. All behavior control flows from Folkways.
//
// Env:
//   FOLKWAYS_ENABLED             unset/"0" = every route in this folder 404s. "1" = live.
//   FOLKWAYS_MODE                "observe" = demo mode (5.3). Anything else = resolve/rewrite.
//   FOLKWAYS_URL                (default http://localhost:4600)
//   FOLKWAYS_TOKEN_GATEWAY      (default dev-gateway-token)
//   FOLKWAYS_UPSTREAM_BASE_URL  (default https://router.huggingface.co/v1)
//   FOLKWAYS_UPSTREAM_API_KEY   (falls back to HF_TOKEN, then OPENAI_API_KEY)
//   FOLKWAYS_COMMUNITY / _DEPLOYMENT / _ENVIRONMENT (default pottsboro-library/public-chat/development)

import { adapterGate, folkwaysMode } from '../../../flag';
import { passthroughResponseHeaders } from '../../../passthroughHeaders';
import { json } from '../../../json';
import {
	ADAPTER_ID,
	ADAPTER_VERSION,
	cfg,
	currentSafety,
	forwardUpstream,
	handleObserve,
	parseChatRequest,
	postToFolkways,
	reportSafety,
	type ChatRequest
} from '../../../observe';

type PromptSlot = { id: string; content: string };
type Bundle = {
	bundle_version: '1';
	release_id: string;
	context: { community: string; deployment: string; environment: string };
	prompt_slots: { developer: PromptSlot[]; guideline: PromptSlot[] };
	model: { id: string; parameters: Record<string, unknown> };
	model_allowlist: string[];
	provenance: { source: string; commit?: string; created_at: string };
};

// Last-valid bundle cache (per serverless instance). Survives short
// control-plane unavailability; a cold instance with no cache refuses instead.
let cachedBundle: Bundle | null = null;

async function resolveBundle(): Promise<Bundle | null> {
	const c = cfg();
	try {
		const res = await postToFolkways(
			c,
			'/v1/resolve',
			{
				context: c.context,
				adapter_id: ADAPTER_ID,
				adapter_version: ADAPTER_VERSION,
				cached_release_id: cachedBundle?.release_id
			},
			5000
		);
		if (res.status === 304) return cachedBundle;
		if (res.status === 200) {
			cachedBundle = ((await res.json()) as { bundle: Bundle }).bundle;
			return cachedBundle;
		}
		console.error(`[folkways-adapter] resolve returned ${res.status}; using last-valid cache`);
		return cachedBundle;
	} catch (err) {
		console.error(
			`[folkways-adapter] resolve failed (${(err as Error).message}); using last-valid cache`
		);
		return cachedBundle;
	}
}

/** Map authority slots to OpenAI roles at the final boundary. */
function applyBundle(body: ChatRequest, bundle: Bundle): ChatRequest {
	const developer = bundle.prompt_slots.developer.map((s) => s.content.trim()).join('\n\n');
	const guideline = bundle.prompt_slots.guideline.map((s) => s.content.trim()).join('\n\n');
	const system = [developer, guideline ? `# Community guidelines\n${guideline}` : '']
		.filter(Boolean)
		.join('\n\n');

	return {
		...body,
		...bundle.model.parameters, // hard parameters win over host values
		model: bundle.model.id, // hard model selection
		messages: [
			// The community bundle replaces any host-supplied system prompt.
			...(system ? [{ role: 'system', content: system }] : []),
			...body.messages.filter((m) => m.role !== 'system')
		]
	};
}

// Post a trace, bounded to 2s. Tracing never fails a chat request. It is awaited
// (not fire-and-forget) because a serverless instance can freeze the moment the
// response is returned, which would drop an un-awaited fetch.
async function postTrace(bundle: Bundle, detail: Record<string, unknown>): Promise<void> {
	const c = cfg();
	try {
		await postToFolkways(c, '/v1/traces', {
			trace_version: '1',
			release_id: bundle.release_id,
			context: bundle.context,
			adapter_id: ADAPTER_ID,
			served_model: bundle.model.id,
			request_id: crypto.randomUUID(),
			detail
		});
	} catch (err) {
		console.error(`[folkways-adapter] trace failed: ${(err as Error).message}`);
	}
}
export const POST = async ({ request }: { request: Request }) => {
	const gate = await adapterGate(request);
	if (gate) return gate;
	if (folkwaysMode() === 'observe') return handleObserve(request);

	const bundle = await resolveBundle();
	if (!bundle) {
		return json(503, { error: { message: 'no active Folkways release and no cached bundle' } });
	}
	if (!bundle.model_allowlist.includes(bundle.model.id)) {
		// Cannot happen for a passed release; refuse rather than serve out-of-policy.
		return json(502, { error: { message: 'bundle model not in allowlist' } });
	}

	const body = await parseChatRequest(request);
	if (!body) return json(400, { error: { message: 'invalid chat.completions request' } });

	const c = cfg();
	const hostRequestedModel = body.model;
	const outbound = applyBundle(body, bundle);

	const upstream = await forwardUpstream(c, outbound);

	// Resolve mode's trace/safety-report calls are already `await`ed inline (not floating promises),
	// so they don't hit the Vercel freeze that observe mode guards against and don't need runInBackground here.
	const safety = await currentSafety();
	await postTrace(bundle, {
		host_requested_model: hostRequestedModel ?? null,
		model_overridden: hostRequestedModel !== bundle.model.id,
		host_system_prompt_replaced: body.messages.some((m) => m.role === 'system'),
		stream: Boolean(body.stream),
		upstream_status: upstream.status,
		// Which safety rule set the host was enforcing when it served this request.
		safety_rules_hash: safety?.rules_hash ?? null,
		safety_detector: safety?.detector ?? null,
		safety_rules_json_enforced: safety?.rules_json_enforced ?? null,
		safety_output_moderation: safety?.output_moderation ?? null
	});
	if (safety) await reportSafety(bundle.context, safety);

	// Stream straight through: SSE or JSON, with the gateway's provenance headers carried across
	// (CUR-1452): rebuilding the response with content-type alone would silently remove the only
	// header naming the model that served.
	return new Response(upstream.body, {
		status: upstream.status,
		headers: passthroughResponseHeaders(upstream.headers)
	});
};

// Health probe: confirms the route is deployed and shows the pinned release (resolve mode) or
// the mode (observe).
export const GET = async ({ request }: { request: Request }) => {
	const gate = await adapterGate(request);
	if (gate) return gate;
	return json(200, {
		ok: true,
		adapter: `${ADAPTER_ID}@${ADAPTER_VERSION}`,
		mode: folkwaysMode(),
		cached_release: cachedBundle?.release_id ?? null
	});
};
