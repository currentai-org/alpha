import StepByStep from './StepByStep.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import type { Message } from '$lib/chat/types/Message';

// An answer sent with the picker on Auto says so in X-ray, so a visitor can tell Alpha chose the
// model for them, and why (CUR-3944).
const answer = (autoRoute?: Message['autoRoute']): Message =>
	({
		id: 'm1',
		from: 'assistant',
		content: 'Hola.',
		updates: [],
		children: [],
		ancestors: [],
		routerMetadata: { model: 'mistral-large-2512', route: '', backend: 'https://api.mistral.ai/v1', provider: 'mistral' },
		autoRoute
	}) as unknown as Message;

const autoStep = (container: HTMLElement) => container.querySelector('[data-step-id="auto-route"]');

describe("X-ray's step by step", () => {
	it("names the model Auto chose and gives Auto's own reason, on a turn Auto routed", async () => {
		const { container } = await render(StepByStep, {
			message: answer({
				model: 'mistral-large',
				reasons: ['Spanish', 'Medium task'],
				explanation: 'A Spanish medium task, so Mistral answers.'
			})
		});
		const step = autoStep(container);
		expect(step, 'an Auto-routed turn lists no Auto step').not.toBeNull();
		expect(step?.textContent).toContain('Auto chose Mistral Large 3');
		expect(step?.textContent).toContain('A Spanish medium task, so Mistral answers.');
	});

	it('lists no Auto step on a turn whose model the person picked', async () => {
		const { container } = await render(StepByStep, { message: answer() });
		expect(autoStep(container)).toBeNull();
	});

	it('lists no Auto step when the recorded choice names no catalog model (fail closed)', async () => {
		const { container } = await render(StepByStep, {
			message: answer({ model: 'not-a-model', reasons: [], explanation: 'x' })
		});
		expect(autoStep(container)).toBeNull();
	});
});
