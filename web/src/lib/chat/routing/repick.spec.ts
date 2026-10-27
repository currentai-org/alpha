import { describe, expect, it } from 'vitest';
import { failureMarksModelBusy, modelAnsweredNobody, repickedNote, shouldRepick, slowToStartLine, type FailedTurn } from './repick';

const autoRoute = { model: 'alia-40b', reasons: ['Basque', 'Medium task'], explanation: 'ALIA is the strongest at Basque.' };
const silentAutoTurn: FailedTurn = {
	enabled: true,
	autoRoute,
	isRetry: false,
	attach: false,
	statusCode: 504,
	modelSilent: true,
	contentSeen: false,
};

describe('shouldRepick (CUR-4384)', () => {
	it('picks again when the model Auto chose refused with a 429 or stayed silent before any text', () => {
		expect(shouldRepick(silentAutoTurn)).toBe(true);
		expect(shouldRepick({ ...silentAutoTurn, statusCode: 429, modelSilent: false })).toBe(true);
	});

	it('never picks again for a hand pick, a retry, a re-attached task, a turn that showed text, or the flag off', () => {
		expect(shouldRepick({ ...silentAutoTurn, autoRoute: undefined })).toBe(false);
		expect(shouldRepick({ ...silentAutoTurn, isRetry: true })).toBe(false);
		expect(shouldRepick({ ...silentAutoTurn, attach: true })).toBe(false);
		expect(shouldRepick({ ...silentAutoTurn, contentSeen: true })).toBe(false);
		expect(shouldRepick({ ...silentAutoTurn, enabled: false })).toBe(false);
	});

	it('picks again at most once: a turn that is itself a re-pick ends on its error', () => {
		expect(shouldRepick({ ...silentAutoTurn, autoRoute: { ...autoRoute, repickedFrom: 'mistral-large' } })).toBe(false);
	});

	it('a 404 before any answer text re-picks once (CUR-4629: the router had no working entry for Large 4)', () => {
		const notFound = { ...silentAutoTurn, statusCode: 404, modelSilent: false };
		expect(shouldRepick(notFound)).toBe(true);
		expect(shouldRepick({ ...notFound, autoRoute: { ...autoRoute, repickedFrom: 'mistral-large-2610' } })).toBe(false);
	});

	it('a 5xx before any answer text re-picks, the same as a 429 (CUR-4629)', () => {
		for (const statusCode of [500, 502, 503]) {
			expect(shouldRepick({ ...silentAutoTurn, statusCode, modelSilent: false }), String(statusCode)).toBe(true);
		}
	});

	it('a 404 or 5xx after answer text has started keeps the error, so two models never share one answer', () => {
		expect(shouldRepick({ ...silentAutoTurn, statusCode: 404, modelSilent: false, contentSeen: true })).toBe(false);
		expect(shouldRepick({ ...silentAutoTurn, statusCode: 503, modelSilent: false, contentSeen: true })).toBe(false);
	});

	it('a hand-picked model that fails with a 404 is never swapped for another', () => {
		expect(shouldRepick({ ...silentAutoTurn, autoRoute: undefined, statusCode: 404, modelSilent: false })).toBe(false);
	});

	it('leaves a failure that is about our request alone (400, 401, 413), so it is not hidden behind a second model', () => {
		for (const statusCode of [400, 401, 413]) {
			expect(shouldRepick({ ...silentAutoTurn, statusCode, modelSilent: false }), String(statusCode)).toBe(false);
		}
		expect(shouldRepick({ ...silentAutoTurn, statusCode: undefined, modelSilent: false })).toBe(false);
	});
});

describe('modelAnsweredNobody (CUR-4629)', () => {
	it("counts a 429, a 404, a 5xx and a silent model as the model answering nobody, and our request's 4xx as not", () => {
		expect(modelAnsweredNobody(429, false)).toBe(true);
		expect(modelAnsweredNobody(404, false)).toBe(true);
		expect(modelAnsweredNobody(500, false)).toBe(true);
		expect(modelAnsweredNobody(599, false)).toBe(true);
		expect(modelAnsweredNobody(undefined, true)).toBe(true);
		expect(modelAnsweredNobody(400, false)).toBe(false);
		expect(modelAnsweredNobody(401, false)).toBe(false);
		expect(modelAnsweredNobody(undefined, false)).toBe(false);
	});
});

describe('repickedNote (CUR-4384)', () => {
	const next = { model: 'mistral-medium', reasons: ['Basque', 'Medium task'], explanation: 'Mistral Medium suits this.' };

	it("names the model that didn't answer and the one Auto asked instead, ahead of Auto's own reason", () => {
		const note = repickedNote('alia-40b', next);
		expect(note?.model).toBe('mistral-medium');
		expect(note?.repickedFrom).toBe('alia-40b');
		expect(note?.explanation).toMatch(/^ALIA.*didn't start answering, so Auto asked Mistral Medium.* instead\. Mistral Medium suits this\.$/);
	});

	it('gives no note when Auto would choose the same model again, so the error stands', () => {
		expect(repickedNote('mistral-medium', next)).toBeUndefined();
	});
});

describe('slowToStartLine (CUR-4384)', () => {
	const wait = { answerId: 'a1', model: 'alia-40b', waitMs: 40_000 };

	it('says the model Auto is waiting on is slow to start once half its wait has passed, and that Auto will ask another', () => {
		const line = slowToStartLine({ wait, answerId: 'a1', elapsedMs: 20_000, started: false });
		expect(line).toContain('ALIA');
		expect(line).toMatch(/slow to start/);
		expect(line).toMatch(/Auto will ask another model/);
	});

	it('stays quiet before half the wait, once the model has started, on another answer, and with no wait', () => {
		expect(slowToStartLine({ wait, answerId: 'a1', elapsedMs: 19_999, started: false })).toBeUndefined();
		expect(slowToStartLine({ wait, answerId: 'a1', elapsedMs: 30_000, started: true })).toBeUndefined();
		expect(slowToStartLine({ wait, answerId: 'a2', elapsedMs: 30_000, started: false })).toBeUndefined();
		expect(slowToStartLine({ wait: null, answerId: 'a1', elapsedMs: 30_000, started: false })).toBeUndefined();
	});

	it("never promises a re-pick once the model has started, such as a search round it asked for (CUR-4629)", () => {
		expect(slowToStartLine({ wait, answerId: 'a1', elapsedMs: 39_000, started: true })).toBeUndefined();
	});
});

describe('failureMarksModelBusy (CUR-4661)', () => {
	it('an agent turn the watchdog ended (an approval nobody answered) never marks the chosen model unavailable', () => {
		expect(failureMarksModelBusy({ statusCode: 504, modelSilent: false, route: 'agent' })).toBe(false);
		expect(failureMarksModelBusy({ statusCode: 429, modelSilent: true, route: 'agent' })).toBe(false);
	});

	it("a real failure of the chosen model still marks it, so the composer's unavailable notice still shows", () => {
		expect(failureMarksModelBusy({ statusCode: 429, modelSilent: false, route: 'direct' })).toBe(true);
		expect(failureMarksModelBusy({ statusCode: 504, modelSilent: true, route: undefined })).toBe(true);
		expect(failureMarksModelBusy({ statusCode: 503, modelSilent: false, route: undefined })).toBe(true);
	});

	it('a failure that is about our request (400) marks nothing, agent or not', () => {
		expect(failureMarksModelBusy({ statusCode: 400, modelSilent: false, route: undefined })).toBe(false);
	});
});
