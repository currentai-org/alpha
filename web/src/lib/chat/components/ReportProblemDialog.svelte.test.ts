import ReportProblemDialog from './ReportProblemDialog.svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/chat') } }));
const trackEvent = vi.hoisted(() => vi.fn());
vi.mock('$lib/analytics', () => ({ trackEvent }));

async function openDialog(props: Record<string, unknown> = {}) {
	await page.viewport(1280, 800);
	const { baseElement } = await render(ReportProblemDialog, { open: true, ...props });
	await expect.poll(() => baseElement.querySelector('[data-report-dialog]')).not.toBeNull();
	const dialog = baseElement.querySelector<HTMLElement>('[data-report-dialog]')!;
	// The popup animates in; positions are only comparable once it has settled.
	await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
	return dialog;
}

const option = (dialog: HTMLElement, key: string) =>
	dialog.querySelector<HTMLElement>(`[data-report-category="${key}"]`)!;

describe('ReportProblemDialog', () => {
	it('keeps every kind of problem where it was when picking one adds the question below them', async () => {
		const dialog = await openDialog();
		const before = ['bug', 'ux', 'content', 'other'].map((k) => option(dialog, k).getBoundingClientRect().top);

		option(dialog, 'bug').click();
		await expect.poll(() => dialog.querySelector('#report-detail')).not.toBeNull();
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

		const after = ['bug', 'ux', 'content', 'other'].map((k) => option(dialog, k).getBoundingClientRect().top);
		expect(after).toEqual(before);
	});

	it('opens with the kind it was given already picked and its question showing, under the title it was given', async () => {
		const dialog = await openDialog({ title: 'Tell us what’s missing', initialCategory: 'other' });

		await expect.poll(() => dialog.querySelector('#report-detail')).not.toBeNull();
		expect(option(dialog, 'other').querySelector('[role="radio"]')?.getAttribute('aria-checked')).toBe('true');
		expect(dialog.getAttribute('aria-labelledby') && document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
			'Tell us what’s missing'
		);
	});

	it('counts one open, however many kinds are picked while it is open', async () => {
		trackEvent.mockClear();
		const dialog = await openDialog();
		option(dialog, 'bug').click();
		await expect.poll(() => dialog.querySelector('#report-detail')).not.toBeNull();
		option(dialog, 'ux').click();
		option(dialog, 'other').click();
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		expect(trackEvent.mock.calls.filter(([name]) => name === 'report_problem_clicked')).toHaveLength(1);
	});

	// On screen means inside the window and the topmost thing at its centre, so a control the
	// dialog's own scroll has clipped, or one past the window's bottom edge, does not count. (CUR-3399)
	function onScreen(el: HTMLElement) {
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return r.top >= 0 && r.bottom <= window.innerHeight && !!hit && el.contains(hit);
	}

	it('keeps Send report and its error on screen when a filled-in form is taller than a short window (CUR-3399)', async () => {
		await page.viewport(1280, 576);
		vi.stubGlobal('fetch', vi.fn(async () => new Response('unreachable', { status: 500 })));
		try {
			const { baseElement } = await render(ReportProblemDialog, { open: true });
			await expect.poll(() => baseElement.querySelector('[data-report-dialog]')).not.toBeNull();
			const dialog = baseElement.querySelector<HTMLElement>('[data-report-dialog]')!;
			await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
			option(dialog, 'bug').click();
			await expect.poll(() => dialog.querySelector('[data-report-context]')).not.toBeNull();
			const detail = dialog.querySelector<HTMLTextAreaElement>('#report-detail')!;
			detail.value = 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.';
			detail.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			expect(dialog.scrollHeight, 'the form fits this window, so this test proves nothing').toBeGreaterThan(dialog.clientHeight);

			const send = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Send report')!;
			expect(onScreen(send), 'Send report is off screen').toBe(true);
			send.click();
			await expect.poll(() => dialog.querySelector<HTMLElement>('[role="alert"]')).not.toBeNull();
			expect(onScreen(dialog.querySelector<HTMLElement>('[role="alert"]')!), "the 'Couldn't send' line is off screen").toBe(true);
			expect(onScreen(send), 'after the failed send, Send report is off screen').toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
