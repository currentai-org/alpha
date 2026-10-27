import { describe, expect, it } from 'vitest';
import {
	advisoryReason,
	blockingModels,
	CHAT_MODELS_ANNOTATION,
	measuredDefault,
	UPSTREAM_UNANSWERED_ANNOTATION
} from '../scenarios/helpers/upstreamAdvisory';
import { PICKER } from '../../config/picker';

const on = { enabled: true, allModelsBlock: false };
const chatted = (ids: string) => ({ type: CHAT_MODELS_ANNOTATION, description: ids });
const unanswered = { type: UPSTREAM_UNANSWERED_ANNOTATION, description: 'notice' };

describe('advisoryReason (SOL-277)', () => {
	it('blocks every failure when the gallery has not switched it on', () => {
		expect(
			advisoryReason([unanswered, chatted('swiss-ai/apertus-v1.5-70b')], {
				enabled: false,
				allModelsBlock: false
			})
		).toBeNull();
	});

	it('blocks a failure on the default model, so a real regression still turns the grade red', () => {
		expect(advisoryReason([chatted(PICKER.production[0])], on)).toBeNull();
	});

	it('blocks a test that chatted with the default and another model', () => {
		expect(
			advisoryReason([chatted(`swiss-ai/apertus-v1.5-70b,${PICKER.develop[0]}`)], on)
		).toBeNull();
	});

	it('blocks a failure that started no chat, since nothing says a non-default model caused it', () => {
		expect(advisoryReason([], on)).toBeNull();
	});

	it('lets a failure pinned to a non-default model through as advisory', () => {
		expect(advisoryReason([chatted('swiss-ai/apertus-v1.5-70b')], on)).toBe(
			'non-default-model:swiss-ai/apertus-v1.5-70b'
		);
	});

	it('blocks a non-default model failure when the diff changed model config or the harness', () => {
		expect(
			advisoryReason([chatted('swiss-ai/apertus-v1.5-70b')], {
				enabled: true,
				allModelsBlock: true
			})
		).toBeNull();
	});

	it('scores a turn whose model never answered as not measured, even on the default model', () => {
		expect(advisoryReason([unanswered, chatted(PICKER.production[0])], on)).toBe(
			'upstream-unanswered'
		);
	});

	it('blocks a timed-out turn, default model or not, when the diff changed model config or the harness', () => {
		const touched = { enabled: true, allModelsBlock: true };
		expect(advisoryReason([unanswered, chatted(PICKER.production[0])], touched)).toBeNull();
		expect(advisoryReason([unanswered, chatted('swiss-ai/apertus-v1.5-70b')], touched)).toBeNull();
	});

	it("takes every site's default as blocking, so develop's default cannot be waved through either", () => {
		const blocking = blockingModels();
		for (const list of Object.values(PICKER)) expect(blocking.has(list[0])).toBe(true);
		expect(blocking.has('swiss-ai/apertus-v1.5-70b')).toBe(false);
	});
});

describe('advisoryReason with upstreamDown (SOL-367)', () => {
	const ALIA = 'BSC-LT/ALIA-40b-instruct';
	const harnessPush = { enabled: true, allModelsBlock: true, upstreamDown: new Set([ALIA]) };

	it('waives a test that chatted only with a probed-down model, even on a harness-changing push', () => {
		expect(advisoryReason([chatted(ALIA)], harnessPush)).toBe(`upstream-down:${ALIA}`);
	});

	it('waives a probed-down default model too; the fail step still needs some default answer in the run', () => {
		const down = new Set([PICKER.develop[0]]);
		expect(
			advisoryReason([chatted(PICKER.develop[0])], { ...harnessPush, upstreamDown: down })
		).toBe(`upstream-down:${PICKER.develop[0]}`);
	});

	it('still blocks a test that also chatted with a model the probe found up', () => {
		expect(advisoryReason([chatted(`${ALIA},swiss-ai/apertus-v1.5-70b`)], harnessPush)).toBeNull();
	});

	it('still blocks a test that started no chat, since nothing ties it to the down model', () => {
		expect(advisoryReason([], harnessPush)).toBeNull();
	});

	it('blocks everything (no waiver) when the advisory pass is off, even with a down model', () => {
		expect(advisoryReason([chatted(ALIA)], { ...harnessPush, enabled: false })).toBeNull();
	});

	it('changes nothing when the probe found every model up (empty set)', () => {
		expect(advisoryReason([chatted(ALIA)], { ...harnessPush, upstreamDown: new Set() })).toBeNull();
		expect(
			advisoryReason([chatted('swiss-ai/apertus-v1.5-70b')], {
				...on,
				upstreamDown: new Set()
			})
		).toBe('non-default-model:swiss-ai/apertus-v1.5-70b');
	});
});

describe('measuredDefault (SOL-277)', () => {
	it('counts a test that chatted with a default model as a default answer', () => {
		expect(measuredDefault([chatted(PICKER.production[0])])).toBe(true);
	});

	it('does not count a test pinned to a non-default model or one that started no chat', () => {
		expect(measuredDefault([chatted('swiss-ai/apertus-v1.5-70b')])).toBe(false);
		expect(measuredDefault([])).toBe(false);
	});
});
