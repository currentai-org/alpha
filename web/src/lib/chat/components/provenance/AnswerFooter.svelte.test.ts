import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnswerFooter from './AnswerFooter.harness.svelte';

// Under a Spanish visitor's fixed notice, the open-gap card, "How this was made" and the caption
// saying no model wrote the reply all follow the browser language (CUR-2394).
describe('AnswerFooter — captions follow the browser language (CUR-2394)', () => {
	afterEach(cleanup);

	it('says no model wrote a fixed reply in Spanish for a Spanish browser', async () => {
		await render(AnswerFooter, { messageId: 'm1', content: 'x', provenance: 'fixed', lang: 'es' });
		await expect
			.element(page.getByText('Ningún modelo escribió esta respuesta. Es un aviso fijo de Alpha.'))
			.toBeInTheDocument();
	});

	it('says nothing reported a model in German for a German browser', async () => {
		await render(AnswerFooter, { messageId: 'm1', content: 'x', provenance: 'unavailable', lang: 'de' });
		await expect
			.element(page.getByText(/^Keine Herkunft für diese Antwort/))
			.toBeInTheDocument();
	});

	it('keeps the English caption when the language has no table', async () => {
		await render(AnswerFooter, { messageId: 'm1', content: 'x', provenance: 'fixed', lang: 'qu' });
		await expect
			.element(page.getByText('No model wrote this reply. It is a fixed notice from Alpha.'))
			.toBeInTheDocument();
	});
});

// A model with no catalog entry of its own (a reasoning variant) still shows its maker in full, never
// the bare abbreviation "SNAI" (CUR-1873).
describe('AnswerFooter — a reasoning variant names its maker in full (CUR-1873)', () => {
	afterEach(cleanup);

	it('credits the Thinking backup to the Swiss National AI Institute, not "SNAI", and keeps its own name', async () => {
		await render(AnswerFooter, {
			messageId: 'm1',
			content: 'x',
			modelId: 'swiss-ai/apertus-v1.5-70b-thinking',
			backup: true
		});
		await expect
			.element(page.getByText('Swiss National AI Institute · Apertus 1.5 70B Thinking (backup)'))
			.toBeInTheDocument();
	});
});

// Each copy keeps a handle on its reset timer, so a refused copy's 3 s timer cannot cut short the
// "Copied" of a successful copy made after it (CUR-2920).
describe('AnswerFooter — a later copy keeps its own "Copied" (CUR-2920)', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		cleanup();
	});

	it('keeps "Copied" for its full 1.6 s after an earlier refused copy', async () => {
		const writeText = vi.spyOn(navigator.clipboard, 'writeText');
		vi.spyOn(document, 'execCommand').mockReturnValue(false);
		await render(AnswerFooter, { messageId: 'm1', content: 'x', provenance: 'fixed' });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const button = () => page.getByRole('button', { name: /^(Copy to clipboard|Copied|Couldn't copy)$/ });

		writeText.mockRejectedValueOnce(new Error('denied'));
		(button().element() as HTMLButtonElement).click();
		await vi.waitUntil(() => button().element().getAttribute('aria-label') === "Couldn't copy");

		vi.advanceTimersByTime(2500);
		writeText.mockResolvedValueOnce();
		(button().element() as HTMLButtonElement).click();
		await vi.waitUntil(() => button().element().getAttribute('aria-label') === 'Copied');

		// The refused copy's timer was due at 3 s, 0.5 s after the second click.
		vi.advanceTimersByTime(1000);
		await tick();
		expect(button().element().getAttribute('aria-label')).toBe('Copied');

		vi.advanceTimersByTime(700);
		await tick();
		expect(button().element().getAttribute('aria-label')).toBe('Copy to clipboard');
	});
});

// The Second opinion action shows only where X-ray's Step by step offers one, and opens X-ray there
// on this answer (CUR-4187).
describe('AnswerFooter — Second opinion opens X-ray on this answer (CUR-4187)', () => {
	afterEach(cleanup);

	it('offers no Second opinion action on an answer Step by step offers none for', async () => {
		await render(AnswerFooter, { messageId: 'm1', content: 'x' });
		await expect.element(page.getByRole('button', { name: "Where it's weak" })).toBeInTheDocument();
		expect(page.getByRole('button', { name: 'Second opinion' }).elements()).toHaveLength(0);
	});

	it('opens X-ray on this answer and asks it for the second-opinion offer', async () => {
		const { stackOpen, xrayMessageId, xraySecondOpinion } = await import('$lib/chat/stores/stack');
		const { get } = await import('svelte/store');
		stackOpen.set(false);
		await render(AnswerFooter, { messageId: 'm7', content: 'x', secondOpinion: true });
		await page.getByRole('button', { name: 'Second opinion' }).click();
		await tick();
		expect(get(stackOpen)).toBe(true);
		expect(get(xrayMessageId)).toBe('m7');
		expect(get(xraySecondOpinion)).toBe(true);
	});
});
