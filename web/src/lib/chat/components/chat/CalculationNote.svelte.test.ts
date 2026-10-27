import CalculationNote from './CalculationNote.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';

// A refused `calculate` call followed by an evaluated retry (as "11:35 pm + 1 hour 5 minutes" can
// produce) must not leave "could not be worked out" under a stated arrival time. (CUR-3860)
const refused = {
	expression: '11:35 + 1 hour 5 minutes',
	error: 'could not evaluate this; use only numbers, + - * /, and parentheses'
};
const evaluated = { expression: '(11 + 1) * 60 + 35 + 5', result: '760' };

describe('the calculator note', () => {
	it('leaves out a refused call once a later call in the same turn evaluated', async () => {
		const { container } = await render(CalculationNote, { calculations: [refused, evaluated] });
		const rows = [...container.querySelectorAll('[data-testid="calculation"]')].map((r) => r.textContent);
		expect(rows).toEqual(['(11 + 1) * 60 + 35 + 5 = 760']);
		expect(container.textContent).toContain('Worked out with a calculator.');
		expect(container.textContent).not.toContain('could not be worked out');
	});

	it('still says a call could not be worked out when no call in the turn evaluated', async () => {
		const { container } = await render(CalculationNote, { calculations: [refused] });
		expect(container.textContent).toContain('11:35 + 1 hour 5 minutes · could not be worked out');
	});

	it('does not say the answer was worked out with a calculator when no call in the turn evaluated', async () => {
		const { container } = await render(CalculationNote, { calculations: [refused] });
		expect(container.textContent).not.toContain('Worked out with a calculator');
		expect(container.textContent).toContain('the answer above did not come from it');
	});
});
