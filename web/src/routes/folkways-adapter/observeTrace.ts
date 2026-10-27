// Folkways adapter — the observe-mode trace payload (demo plan 4.5, 5.5d).
//
// Pulled out of v1/chat/completions/+server.ts's postObserveTrace so the exact payload shape
// can be unit-tested against a local copy of core/src/contracts.ts's `traceSchema` without
// standing up the route (the adapter imports no Folkways core modules — writing-an-adapter.md
// #1 — so this is a hand-kept mirror, not an import; see assertValidTrace below for the same
// caveat and observeTrace.spec.ts for the tests that pin the two in sync).
import type { DetectedLayers } from './layerDetection';

export type ObserveTracePayload = {
	trace_version: '1';
	release_id: string;
	context: { community: string; deployment: string; environment: string };
	adapter_id: string;
	served_model: string;
	request_id: string;
	detail: Record<string, unknown>;
	prompt_hash: string;
	layers: DetectedLayers;
	status: string;
	timing: { requested_at: string; responded_at: string; duration_ms: number };
};

export function buildObserveTracePayload(fields: {
	context: { community: string; deployment: string; environment: string };
	adapterId: string;
	servedModel: string;
	requestId: string;
	detail: Record<string, unknown>;
	promptHash: string;
	layers: DetectedLayers;
	status: string;
	requestedAt: string;
	respondedAt: string;
	durationMs: number;
}): ObserveTracePayload {
	const payload: ObserveTracePayload = {
		trace_version: '1',
		// Observe mode never calls /v1/resolve, so there is no real release_id to send — the trace
		// schema requires a non-empty one regardless. "observe" is a deliberate, documented
		// placeholder (see the route file and the adapter README).
		release_id: 'observe',
		context: fields.context,
		adapter_id: fields.adapterId,
		served_model: fields.servedModel,
		request_id: fields.requestId,
		detail: fields.detail,
		prompt_hash: fields.promptHash,
		layers: fields.layers,
		status: fields.status,
		timing: {
			requested_at: fields.requestedAt,
			responded_at: fields.respondedAt,
			duration_ms: fields.durationMs
		}
	};
	// The live path checks the payload against the same invariant the spec does, so a real
	// regression (an unlisted key, a `messages` field slipping into `detail`) fails loudly instead of
	// shipping silently. (CUR-1165)
	assertValidTrace(payload);
	return payload;
}

// ---------------------------------------------------------------------------
// A LOCAL, hand-kept mirror of core/src/contracts.ts's `traceSchema` — strict enough to catch
// the one thing that matters here (no `messages`, no chat content, no unlisted top-level key),
// not a full zod re-implementation. Kept deliberately small; if contracts.ts's traceSchema grows
// a field, update both this function and the comment on it.

const TRACE_TOP_LEVEL_KEYS = new Set([
	'trace_version',
	'release_id',
	'context',
	'adapter_id',
	'served_model',
	'request_id',
	'detail',
	'prompt_hash',
	'layers',
	'status',
	'timing'
]);
const CONTEXT_KEYS = new Set(['community', 'deployment', 'environment']);
const LAYERS_KEYS = new Set([
	'persona_override',
	'artifacts',
	'search',
	'rag',
	'conversation_preprompt'
]);
const TIMING_KEYS = new Set(['requested_at', 'responded_at', 'duration_ms']);

/** Throws with a specific reason on the first violation found. Returns void on a valid payload. */
export function assertValidTrace(payload: Record<string, unknown>): void {
	for (const key of Object.keys(payload)) {
		if (!TRACE_TOP_LEVEL_KEYS.has(key)) throw new Error(`unknown top-level trace key: ${key}`);
	}
	if ('messages' in payload) throw new Error('trace must never carry a messages field');

	if (payload.trace_version !== '1') throw new Error('trace_version must be "1"');
	if (typeof payload.release_id !== 'string' || payload.release_id.length < 1) {
		throw new Error('release_id must be a non-empty string');
	}
	if (typeof payload.adapter_id !== 'string' || payload.adapter_id.length < 1) {
		throw new Error('adapter_id must be a non-empty string');
	}
	if (typeof payload.served_model !== 'string' || payload.served_model.length < 1) {
		throw new Error('served_model must be a non-empty string');
	}

	const context = payload.context as Record<string, unknown> | undefined;
	if (!context || typeof context !== 'object') throw new Error('context is required');
	for (const key of Object.keys(context)) {
		if (!CONTEXT_KEYS.has(key)) throw new Error(`unknown context key: ${key}`);
	}
	for (const key of ['community', 'deployment', 'environment']) {
		if (typeof context[key] !== 'string' || (context[key] as string).length < 1) {
			throw new Error(`context.${key} must be a non-empty string`);
		}
	}

	if (payload.detail !== undefined) {
		if (
			typeof payload.detail !== 'object' ||
			payload.detail === null ||
			Array.isArray(payload.detail)
		) {
			throw new Error('detail must be an object');
		}
		// detail is intentionally a loose record (writing-an-adapter.md #1's precedent) — but it must
		// still never carry the one thing this schema exists to forbid.
		if ('messages' in (payload.detail as Record<string, unknown>)) {
			throw new Error('detail must never carry a messages field');
		}
	}

	if (payload.prompt_hash !== undefined) {
		if (typeof payload.prompt_hash !== 'string' || payload.prompt_hash.length < 1) {
			throw new Error('prompt_hash must be a non-empty string when present');
		}
	}

	if (payload.layers !== undefined) {
		const layers = payload.layers as Record<string, unknown>;
		if (typeof layers !== 'object' || layers === null) throw new Error('layers must be an object');
		for (const key of Object.keys(layers)) {
			if (!LAYERS_KEYS.has(key)) throw new Error(`unknown layers key: ${key}`);
			if (layers[key] !== undefined && typeof layers[key] !== 'boolean') {
				throw new Error(`layers.${key} must be a boolean`);
			}
		}
	}

	if (payload.status !== undefined) {
		if (typeof payload.status !== 'string' || payload.status.length < 1) {
			throw new Error('status must be a non-empty string when present');
		}
	}

	if (payload.timing !== undefined) {
		const timing = payload.timing as Record<string, unknown>;
		if (typeof timing !== 'object' || timing === null) throw new Error('timing must be an object');
		for (const key of Object.keys(timing)) {
			if (!TIMING_KEYS.has(key)) throw new Error(`unknown timing key: ${key}`);
		}
		if (
			timing.duration_ms !== undefined &&
			(typeof timing.duration_ms !== 'number' || timing.duration_ms < 0)
		) {
			throw new Error('timing.duration_ms must be a non-negative number');
		}
	}
}
