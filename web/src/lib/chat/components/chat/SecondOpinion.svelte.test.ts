import { render, cleanup } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SecondOpinion from './SecondOpinion.svelte';
import { secondOpinionStart, stackOpen } from '$lib/chat/stores/stack';

// No conversation id, so the run sends no sealed history and the test needs no keyring.
vi.mock('$app/state', () => ({ page: { params: {} } }));
vi.mock('$lib/chat/stores/sessionFootprint.svelte', () => ({
	useSessionFootprintStore: () => ({ recordResponse: () => {} })
}));

// An answer's Second opinion button opens X-ray on the offer and starts the run there, once, so the
// visitor never has to ask a second time.
describe('SecondOpinion — the answer action starts the run once', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const calls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/second-opinion'));

	beforeEach(() => {
		// A run that never returns: the fan-out stays in flight for the whole test.
		fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal('fetch', fetchSpy);
		stackOpen.set(true);
		secondOpinionStart.set(undefined);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		secondOpinionStart.set(undefined);
	});

	it('starts nothing when X-ray was opened without a start request', async () => {
		await render(SecondOpinion, { question: 'q', messageId: 'a-none' });
		await tick();
		expect(calls()).toHaveLength(0);
	});

	it('starts one run for its own answer, and a second request while it runs starts no duplicate', async () => {
		await render(SecondOpinion, { question: 'What is the capital of Australia?', messageId: 'a-run' });
		secondOpinionStart.set('a-run');
		await expect.poll(() => calls().length).toBe(1);
		const body = JSON.parse(String((calls()[0][1] as RequestInit).body));
		expect(body).toMatchObject({ question: 'What is the capital of Australia?', messageId: 'a-run' });

		secondOpinionStart.set('a-run');
		await tick();
		await tick();
		expect(calls()).toHaveLength(1);
	});

	it('starts no duplicate when the offer remounts mid-run, as it does when X-ray switches tabs', async () => {
		const first = await render(SecondOpinion, { question: 'q', messageId: 'a-remount' });
		secondOpinionStart.set('a-remount');
		await expect.poll(() => calls().length).toBe(1);
		first.unmount();

		await render(SecondOpinion, { question: 'q', messageId: 'a-remount' });
		secondOpinionStart.set('a-remount');
		await tick();
		await tick();
		expect(calls()).toHaveLength(1);
	});

	it('ignores a request for a different answer', async () => {
		await render(SecondOpinion, { question: 'q', messageId: 'a-mine' });
		secondOpinionStart.set('a-other');
		await tick();
		expect(calls()).toHaveLength(0);
	});

	it('shows a stored verdict instead of running the panel again', async () => {
		const { container } = await render(SecondOpinion, {
			question: 'q',
			messageId: 'a-done',
			opinions: [{ model: 'm', modelShort: 'M', answer: 'Canberra' }],
			verdict: { agreement: 'high', headline: 'h', consensus: [], contradictions: [] }
		} as never);
		secondOpinionStart.set('a-done');
		await tick();
		await tick();
		expect(calls()).toHaveLength(0);
		expect(container.querySelector('[data-second-opinion-verdict]')).not.toBeNull();
	});

	it('shows a live run\'s verdict again when the offer remounts, and a later request starts no rerun', async () => {
		const done = {
			type: 'done',
			available: true,
			opinions: [
				{ model: 'a', modelShort: 'A', answer: 'Canberra' },
				{ model: 'b', modelShort: 'B', answer: 'Canberra' }
			],
			verdict: { agreement: 'high', headline: 'h', consensus: [], contradictions: [] }
		};
		fetchSpy.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(done) + '\n')));
		const first = await render(SecondOpinion, { question: 'q', messageId: 'a-kept' });
		secondOpinionStart.set('a-kept');
		await expect.poll(() => first.container.querySelector('[data-second-opinion-verdict]')).not.toBeNull();
		first.unmount();

		const again = await render(SecondOpinion, { question: 'q', messageId: 'a-kept' });
		expect(again.container.querySelector('[data-second-opinion-verdict]')).not.toBeNull();
		secondOpinionStart.set('a-kept');
		await tick();
		await tick();
		expect(calls()).toHaveLength(1);
	});

	it('drops a pending request when X-ray closes, so a later open starts nothing', async () => {
		secondOpinionStart.set('a-closed');
		stackOpen.set(false);
		stackOpen.set(true);
		await render(SecondOpinion, { question: 'q', messageId: 'a-closed' });
		await tick();
		expect(calls()).toHaveLength(0);
	});
});
