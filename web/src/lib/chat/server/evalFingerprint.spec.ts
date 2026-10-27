import { expect, it } from 'vitest';
import { evalFingerprint } from './evalFingerprint';

it('changes for answer settings but stays stable across object order and cosmetic metadata', () => {
	const model = { preprompt: 'Persona', parameters: { temperature: 0.7, max_tokens: 500 } };
	expect(evalFingerprint(model)).toBe(evalFingerprint({ ...model, parameters: { max_tokens: 500, temperature: 0.7 } }));
	expect(evalFingerprint(model)).not.toBe(evalFingerprint({ ...model, preprompt: 'Updated persona' }));
	expect(evalFingerprint(model)).not.toBe(evalFingerprint({ ...model, parameters: { temperature: 0.5, max_tokens: 500 } }));
	const renamed = { ...model, displayName: 'New label' };
	expect(evalFingerprint(model)).toBe(evalFingerprint(renamed));
});
