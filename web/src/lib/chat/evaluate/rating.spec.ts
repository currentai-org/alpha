import { describe, expect, it } from 'vitest';
import { missingQuestions, toScores } from './rating';
import { CANT_TELL, type EvalQuestion } from './types';

const scale: EvalQuestion = {
	key: 'accuracy',
	type: 'scale',
	required: true,
	label: 'Is what it says correct?',
	allowCantTell: true,
	options: [1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }))
};
const choice: EvalQuestion = {
	key: 'usable',
	type: 'choice',
	required: true,
	label: 'Would you use this answer?',
	options: [
		{ value: 'as_is', label: 'Yes' },
		{ value: 'no', label: 'No' }
	]
};

describe('missingQuestions', () => {
	it('names every required question left unanswered, in rubric order', () => {
		expect(missingQuestions([scale, choice], {}, false)).toEqual(['accuracy', 'usable']);
		expect(missingQuestions([scale, choice], { usable: 'no' }, false)).toEqual(['accuracy']);
	});

	it('asks nothing more once the request is flagged as badly written (the rating is excluded)', () => {
		expect(missingQuestions([scale, choice], {}, true)).toEqual([]);
	});
});

describe('toScores', () => {
	it("sends a scale answer back as the option's number, not the radio's string", () => {
		expect(toScores([scale, choice], { accuracy: '4', usable: 'as_is' })).toEqual({ accuracy: 4, usable: 'as_is' });
	});

	it("keeps \"I can't tell\" and drops values no option has", () => {
		expect(toScores([scale, choice], { accuracy: CANT_TELL, usable: 'maybe' })).toEqual({ accuracy: CANT_TELL });
	});
});
