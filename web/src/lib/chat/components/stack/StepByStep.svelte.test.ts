import StepByStep from './StepByStep.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import type { Message } from '$lib/chat/types/Message';

// A maths answer captioned "Worked out with a calculator" must list a calculator step in X-ray's Step
// by step, which lists only what happened (CUR-3943).
const answer = (calculations?: Message['calculations']): Message =>
	({
		id: 'm1',
		from: 'assistant',
		content: '14 notebooks cost 35 euros.',
		updates: [],
		children: [],
		ancestors: [],
		routerMetadata: { model: 'mistral-large-2512', route: '', backend: 'https://api.mistral.ai/v1', provider: 'mistral' },
		calculations
	}) as unknown as Message;

const calculatorStep = (container: HTMLElement) => container.querySelector('[data-step-id="calculator"]');
const writeStep = (container: HTMLElement) => container.querySelector('[data-step-id="write"]');

// A Large 3 turn answered by Mistral Medium says "(backup)" in its footer, and X-ray's Step by step
// must say the same instead of reading as if Medium had been picked (CUR-3968).
const backupAnswer = (reason: 'unavailable' | 'skipped'): Message =>
	({
		...answer(),
		routerMetadata: { model: 'mistral-medium-2604', route: '', backend: 'https://api.mistral.ai/v1', provider: 'mistral' },
		failover: { from: 'mistral-large-2512', to: 'mistral-medium-2604', reason }
	}) as unknown as Message;

describe("X-ray's step by step after a failover (CUR-3968)", () => {
	it('names the picked model as not answering and the served one as the backup', async () => {
		const { container } = await render(StepByStep, { message: backupAnswer('unavailable') });
		const text = writeStep(container)?.textContent ?? '';
		expect(text).toContain("Mistral Large 3 didn't answer, so Mistral Medium 3.5 answered instead, as the backup.");
	});

	it('says the picked model was skipped when the turn skipped it', async () => {
		const { container } = await render(StepByStep, { message: backupAnswer('skipped') });
		expect(writeStep(container)?.textContent).toContain('Mistral Large 3 was skipped, so Mistral Medium 3.5');
	});

	it('mentions no backup on a turn the picked model answered', async () => {
		const { container } = await render(StepByStep, { message: answer() });
		const text = writeStep(container)?.textContent ?? '';
		expect(text).toContain('Mistral Large 3');
		expect(text).not.toMatch(/backup|didn't answer|skipped/);
	});
});

describe("X-ray's step by step", () => {
	it('lists the calculator, with the sum code worked out, on a turn whose answer used one', async () => {
		const { container } = await render(StepByStep, {
			message: answer([{ expression: '(7.50 / 3) * 14', result: '35' }])
		});
		const step = calculatorStep(container);
		expect(step, 'a turn that called the calculator lists no calculator step').not.toBeNull();
		expect(step?.textContent).toContain('Used a calculator');
		expect(step?.textContent).toContain('(7.50 / 3) * 14 = 35');
		expect(step?.textContent).not.toMatch(/checked|verified/i);
	});

	it('lists no calculator step on a turn that never called it', async () => {
		const { container } = await render(StepByStep, { message: answer() });
		expect(calculatorStep(container)).toBeNull();
	});

	it('says the calculator could not read the sum when every call was refused, and shows no sum', async () => {
		const { container } = await render(StepByStep, {
			message: answer([{ expression: '11:35 + 1 hour 5 minutes', error: 'could not evaluate this' }])
		});
		const step = calculatorStep(container);
		expect(step?.textContent).toContain('could not read the sum, so the answer did not come from it');
		expect(step?.textContent).not.toContain(' = ');
	});
});

// Apertus was told by name to answer in Hausa, and X-ray says so. (CUR-2237)
describe("X-ray's step by step when the answer was asked for in a language (CUR-2237)", () => {
	const languageStep = (container: HTMLElement) => container.querySelector('[data-step-id="answer-language"]');

	it('says the answer was asked for in Hausa on a turn that named it', async () => {
		const message = { ...answer(), routerMetadata: { ...answer().routerMetadata!, answerLanguage: 'hau' } } as Message;
		const { container } = await render(StepByStep, { message });
		expect(languageStep(container)?.textContent).toContain('Asked for an answer in Hausa');
	});

	it('lists no language step on a turn that named none', async () => {
		const { container } = await render(StepByStep, { message: answer() });
		expect(languageStep(container)).toBeNull();
	});
});

// The second-opinion step named how many models were asked but never where any of them ran. (CUR-3563)
describe("X-ray's step by step after a second opinion (CUR-3563)", () => {
	const opinion = (modelShort: string, extra: Record<string, string> = {}) => ({
		model: modelShort.toLowerCase(),
		modelShort,
		openness: 'open weights',
		sovereign: false,
		answer: 'Canberra.',
		...extra
	});
	const checked = {
		...answer(),
		verdict: { agreement: 'high', headline: 'They agree.' },
		opinions: [opinion('GLM 5.2', { backend: 'router.huggingface.co', provider: 'novita' }), opinion('Bielik 11B v3')]
	} as unknown as Message;

	it("names each panelist's recorded host, and says so for one with none recorded", async () => {
		const { container } = await render(StepByStep, { message: checked });
		const text = container.querySelector('[data-step-id="second-opinion"]')?.textContent ?? '';
		expect(text).toContain('GLM 5.2 ran on Novita AI via Hugging Face.');
		expect(text).toContain('Where Bielik 11B v3 ran was not recorded.');
	});
});

// A photo question answered from the photo must not read, in Step by step, "Nothing was looked up,
// so this is from what the AI learned in training" while This answer names the photo it read (CUR-4353).
describe("X-ray's step by step on a question with a file attached (CUR-4353)", () => {
	it('names the attached file as what the answer worked from, and never says nothing was looked up', async () => {
		const { container } = await render(StepByStep, { message: answer(), attachedFiles: ['red-maple.jpg'] });
		const text = writeStep(container)?.textContent ?? '';
		expect(text).toContain('It worked from the file you attached: red-maple.jpg.');
		expect(text).not.toMatch(/nothing was looked up/i);
	});

	it('still says nothing was looked up on a turn with no file and no sources', async () => {
		const { container } = await render(StepByStep, { message: answer() });
		expect(writeStep(container)?.textContent).toMatch(/nothing was looked up/i);
	});
});
