import AgentConfirmPrompt from './AgentConfirmPrompt.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';

// after Allow, the resolved card fell back to the agent's raw call title, which arrives
// HTML-escaped ("Approve terminal: rm &amp;&amp; ls"), while the open card led with the plain sentence.
const card = {
	conversationId: 'c1',
	taskId: 't1',
	confirmId: 'k1',
	kind: 'execute',
	title: 'Approve terminal: rm &amp;&amp; ls',
	summary: 'rm notes.txt && ls',
	plain: 'This deletes the file notes.txt, so I need your confirmation',
};

describe('a resolved agent approval card', () => {
	it('reads its plain sentence, not the raw call title, once allowed', async () => {
		const { container } = await render(AgentConfirmPrompt, { ...card, decision: 'allow' });
		expect(container.textContent).toContain(
			'This deletes the file notes.txt, so I need your confirmation — Allowed.'
		);
		expect(container.textContent).not.toContain('Approve terminal');
	});

	it('falls back to the call title when the frame carries no plain sentence', async () => {
		const { container } = await render(AgentConfirmPrompt, {
			...card,
			plain: undefined,
			title: 'run set_setting on stub',
			decision: 'allow',
		});
		expect(container.textContent).toContain('run set_setting on stub — Allowed.');
	});
});
