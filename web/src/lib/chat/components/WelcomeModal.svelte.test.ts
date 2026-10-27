import WelcomeModal from './WelcomeModal.svelte';
import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';

// The credits row reads the served models off the layout data.
const appState = vi.hoisted(() => ({
	page: { data: {} as { models?: { id: string }[]; clefRoutingEnabled?: boolean } }
}));
vi.mock('$app/state', () => appState);

async function open(
	models: { id: string }[] = [],
	viewport: [number, number] = [1280, 800],
	clefRoutingEnabled = false
) {
	await page.viewport(...viewport);
	appState.page.data = { models, clefRoutingEnabled };
	const onTakeTour = vi.fn();
	const onStartChatting = vi.fn();
	// Records whether the welcome was still on screen when the seen mark would be saved.
	const onDismiss = vi.fn(() => !!document.querySelector('[data-welcome]'));
	const { baseElement } = await render(WelcomeModal, { onTakeTour, onStartChatting, onDismiss });
	await expect.poll(() => baseElement.querySelector('[data-welcome]')).not.toBeNull();
	const dialog = baseElement.querySelector<HTMLElement>('[data-welcome]')!;
	return {
		dialog,
		onTakeTour,
		onStartChatting,
		onDismiss,
		credits: () => baseElement.querySelector('[aria-label="Made with open parts from"]')?.textContent ?? null
	};
}

describe('WelcomeModal hands over to the tour, and every other way out is a skip', () => {
	it('opens with focus on Take the tour, so Enter takes it', async () => {
		await open();
		await expect.poll(() => document.activeElement?.hasAttribute('data-welcome-tour')).toBe(true);
	});

	it('Take the tour reports the tour, not a skip, and only once the welcome has gone', async () => {
		const w = await open();
		w.dialog.querySelector<HTMLElement>('[data-welcome-tour]')!.click();
		await expect.poll(() => w.onTakeTour.mock.calls.length).toBe(1);
		expect(w.onStartChatting).not.toHaveBeenCalled();
		expect(document.querySelector('[data-welcome]')).toBeNull();
	});

	it('Start chatting is a skip', async () => {
		const w = await open();
		w.dialog.querySelector<HTMLElement>('[data-welcome-start]')!.click();
		await expect.poll(() => w.onStartChatting.mock.calls.length).toBe(1);
		expect(w.onTakeTour).not.toHaveBeenCalled();
	});

	// The seen mark must not wait for the close animation, or a reload in that window
	// never sends it and the welcome comes back on the next load. (CUR-4348)
	it('reports the dismissal while the welcome is still closing, before it hands over, so a reload then keeps the seen mark', async () => {
		const w = await open();
		w.dialog.querySelector<HTMLElement>('[data-welcome-start]')!.click();
		flushSync();
		expect(w.onDismiss, 'the dismissal waited for the close animation').toHaveBeenCalledTimes(1);
		expect(w.onDismiss.mock.results[0].value).toBe(true);
		expect(w.onStartChatting, 'the handover ran before the close animation').not.toHaveBeenCalled();
		await expect.poll(() => w.onStartChatting.mock.calls.length).toBe(1);
		expect(w.onDismiss).toHaveBeenCalledTimes(1);
	});

	it('reports an Escape dismissal once, before the skip', async () => {
		const w = await open();
		await userEvent.keyboard('{Escape}');
		await expect.poll(() => w.onStartChatting.mock.calls.length).toBe(1);
		expect(w.onDismiss).toHaveBeenCalledTimes(1);
		expect(w.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(w.onStartChatting.mock.invocationCallOrder[0]);
	});

	it('Escape is a skip, not a silent close that leaves nobody pointed at the tour', async () => {
		const w = await open();
		await userEvent.keyboard('{Escape}');
		await expect.poll(() => w.onStartChatting.mock.calls.length).toBe(1);
		expect(w.onTakeTour).not.toHaveBeenCalled();
	});

	// Without a mouse, Tab must not go to the buttons hidden behind the welcome. A button outside the dialog stands in for the app behind it. (CUR-4259)
	it('Tab and Shift+Tab stay inside the welcome, never reaching the app behind it', async () => {
		const behind = document.body.appendChild(document.createElement('button'));
		behind.textContent = 'behind';
		try {
			const w = await open();
			await expect.poll(() => document.activeElement?.hasAttribute('data-welcome-tour')).toBe(true);
			for (const key of ['{Tab}', '{Tab}', '{Tab}', '{Shift>}{Tab}{/Shift}', '{Shift>}{Tab}{/Shift}', '{Shift>}{Tab}{/Shift}']) {
				await userEvent.keyboard(key);
				expect(w.dialog.contains(document.activeElement), `${key} left the welcome`).toBe(true);
			}
		} finally {
			behind.remove();
		}
	});

	// On a phone "Start chatting" must not fall below the fold. A 375×600 window is a
	// small phone with the browser's bars showing. (CUR-4260)
	it('on a small phone both ways forward are on screen without scrolling', async () => {
		const w = await open([{ id: 'swiss-ai/apertus-v1.5-70b' }, { id: 'BSC-LT/ALIA-40b-instruct' }], [375, 600]);
		await expect.poll(() => Math.round(w.dialog.getBoundingClientRect().bottom)).toBe(window.innerHeight);
		for (const marker of ['[data-welcome-tour]', '[data-welcome-start]']) {
			const box = w.dialog.querySelector(marker)!.getBoundingClientRect();
			expect(box.top, `${marker} starts above the window`).toBeGreaterThanOrEqual(0);
			expect(box.bottom, `${marker} is below the fold`).toBeLessThanOrEqual(window.innerHeight);
		}
	});

	it('is a bottom sheet on a phone, with the same two ways forward', async () => {
		const w = await open([], [390, 844]);
		expect(w.dialog.hasAttribute('data-sheet')).toBe(true);
		// The sheet slides up; its resting place is the window's bottom edge.
		await expect.poll(() => Math.round(w.dialog.getBoundingClientRect().bottom)).toBe(window.innerHeight);
		expect(w.dialog.querySelector('[data-welcome-tour]')).not.toBeNull();
		expect(w.dialog.querySelector('[data-welcome-start]')).not.toBeNull();
	});
});

// The credits row names who made and who runs the models this deployment serves (CUR-2565).
describe('WelcomeModal credits', () => {
	it('credits only the makers and hosts of served models, so production names no develop-only maker', async () => {
		const w = await open([{ id: 'swiss-ai/apertus-v1.5-70b' }]);
		expect(w.credits()).toContain('Phoeniqs');
		expect(w.credits()).not.toContain('Barcelona Supercomputing Center');
		expect(w.credits()).not.toContain('AI Singapore');
	});

	it('credits BSC where ALIA is served', async () => {
		const w = await open([{ id: 'swiss-ai/apertus-v1.5-70b' }, { id: 'BSC-LT/ALIA-40b-instruct' }]);
		expect(w.credits()).toContain('Barcelona Supercomputing Center');
	});

	it('shows no credits row rather than an empty one when no served model is in the catalog', async () => {
		const w = await open([{ id: 'unknown/model' }]);
		expect(w.credits()).toBeNull();
	});

	it('credits Cloudflare for Clef where Auto asks Clef to read a draft', async () => {
		const w = await open([{ id: 'swiss-ai/apertus-v1.5-70b' }], [1280, 800], true);
		expect(w.credits()).toContain('Cloudflare');
	});

	it('names no Cloudflare where Clef is off (fails closed: the draft is read in the browser only)', async () => {
		const w = await open([{ id: 'swiss-ai/apertus-v1.5-70b' }]);
		expect(w.credits()).not.toContain('Cloudflare');
	});
});

// The welcome is modal for a keyboard visitor. Tab never leaves the dialog for the page
// behind it, and Escape is a skip, the same as Start chatting. (CUR-4259)
describe('WelcomeModal keyboard', () => {
	it('keeps Tab inside the dialog, and Escape reports a skip rather than the tour', async () => {
		const outside = document.createElement('button');
		outside.textContent = 'behind the welcome';
		document.body.appendChild(outside);
		try {
			const w = await open();
			const dialog = w.dialog.closest<HTMLElement>('[role="dialog"]') ?? w.dialog;
			expect(dialog.getAttribute('aria-modal')).toBe('true');
			await expect.poll(() => document.activeElement?.hasAttribute('data-welcome-tour')).toBe(true);
			for (let i = 0; i < 25; i++) {
				await userEvent.tab();
				expect(dialog.contains(document.activeElement), `Tab ${i + 1} left the dialog`).toBe(true);
			}
			await userEvent.keyboard('{Escape}');
			await expect.poll(() => w.onStartChatting.mock.calls.length).toBe(1);
			expect(w.onTakeTour).not.toHaveBeenCalled();
		} finally {
			outside.remove();
		}
	});
});
