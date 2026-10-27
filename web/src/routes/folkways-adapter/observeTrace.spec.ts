import { describe, expect, it } from 'vitest';
import { buildObserveTracePayload, assertValidTrace } from './observeTrace';
import { detectLayers } from './layerDetection';

const baseFields = {
	context: {
		community: 'pottsboro-library',
		deployment: 'public-chat',
		environment: 'development'
	},
	adapterId: 'openai-gateway',
	servedModel: 'swiss-ai/apertus-v1.5-70b',
	requestId: 'req-1',
	detail: { mode: 'observe', stream: false, upstream_status: 200 },
	promptHash: 'a'.repeat(64),
	layers: detectLayers('<retrieved_web_sources>[1] x</retrieved_web_sources>', true),
	status: 'ok',
	requestedAt: '2026-09-10T00:00:00.000Z',
	respondedAt: '2026-09-10T00:00:01.000Z',
	durationMs: 1000
};

describe('folkways-adapter observeTrace', () => {
	it('builds a payload that validates against the strict trace schema', () => {
		const payload = buildObserveTracePayload(baseFields);
		expect(() => assertValidTrace(payload)).not.toThrow();
	});

	it('never carries a messages field, top-level or in detail', () => {
		const payload = buildObserveTracePayload(baseFields) as Record<string, unknown>;
		expect(payload).not.toHaveProperty('messages');
		expect(payload.detail).not.toHaveProperty('messages');
	});

	// assertValidTrace is called on the live path through buildObserveTracePayload (CUR-1165), and
	// this test builds the payload the same way the real caller does. The other 'rejects' tests below
	// construct an already-built payload by hand and never touch buildObserveTracePayload's own
	// return path, so they cannot see a missing validation call there.
	it('rejects at build time, not just when assertValidTrace is called separately, if detail carries messages', () => {
		expect(() =>
			buildObserveTracePayload({
				...baseFields,
				detail: { ...baseFields.detail, messages: [{ role: 'user', content: 'hi' }] }
			})
		).toThrow(/detail must never carry a messages field/);
	});

	it('release_id is the documented "observe" placeholder — observe mode never calls /v1/resolve', () => {
		const payload = buildObserveTracePayload(baseFields);
		expect(payload.release_id).toBe('observe');
	});

	it('carries exactly the allowed top-level keys (no bundle/model_slots/anything else)', () => {
		const payload = buildObserveTracePayload(baseFields);
		expect(Object.keys(payload).sort()).toEqual(
			[
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
			].sort()
		);
	});

	it('rejects a payload carrying an unlisted top-level key (assertValidTrace catches drift)', () => {
		const payload = buildObserveTracePayload(baseFields) as Record<string, unknown>;
		expect(() =>
			assertValidTrace({ ...payload, messages: [{ role: 'user', content: 'hi' }] })
		).toThrow(/messages/);
		expect(() => assertValidTrace({ ...payload, bundle: {} })).toThrow(/unknown top-level/);
	});

	it('rejects an empty release_id (the field is required and non-empty)', () => {
		const payload = buildObserveTracePayload(baseFields) as Record<string, unknown>;
		expect(() => assertValidTrace({ ...payload, release_id: '' })).toThrow(/release_id/);
	});

	it('rejects a non-boolean layers value', () => {
		const payload = buildObserveTracePayload(baseFields) as Record<string, unknown>;
		const layers = { ...(payload.layers as Record<string, unknown>), search: 'yes' };
		expect(() => assertValidTrace({ ...payload, layers })).toThrow(/layers\.search/);
	});

	it('accepts a payload with layers/prompt_hash/status/timing all omitted (they are optional)', () => {
		const minimal = {
			trace_version: '1' as const,
			release_id: 'observe',
			context: baseFields.context,
			adapter_id: baseFields.adapterId,
			served_model: baseFields.servedModel,
			request_id: baseFields.requestId,
			detail: {}
		};
		expect(() => assertValidTrace(minimal)).not.toThrow();
	});
});
