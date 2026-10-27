import WeakSpotsModal from './WeakSpotsModal.svelte';
import { weakSpotsOpen } from '$lib/chat/stores/weakSpots';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';

// At 1024x576 the dialog is taller than the window. bits-ui
// hands `onOpenAutoFocus` an event dispatched on no element, so Modal's `[data-autofocus]` lookup
// through `e.target` found nothing and focus fell to the first tabbable element, the Trust & Safety
// link at the bottom. Focusing it scrolled the title and the close control out of view.
// e2e-moved: scenarios/weak-spots-dialog-fits.spec.ts › the Where it's weak dialog opens at its title, with the close control and a cue for more text in view (CUR-2744)
describe('WeakSpotsModal on open', () => {
	afterEach(() => weakSpotsOpen.set(false));

	it('opens at its title, with the title focused and the close control in view, in a window shorter than the dialog', async () => {
		await page.viewport(1024, 576);
		weakSpotsOpen.set(true);
		const { baseElement } = await render(WeakSpotsModal);
		const title = page.getByRole('heading', { name: "Where it's weak" });
		await expect.element(title).toBeInTheDocument();
		// bits-ui moves focus in a requestAnimationFrame after mount, so wait two frames before reading.
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

		const popup = baseElement.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(popup.scrollHeight, 'the dialog fits the window, so this test proves nothing').toBeGreaterThan(
			popup.clientHeight
		);
		expect(document.activeElement?.textContent).toBe("Where it's weak");
		expect(popup.scrollTop, 'the dialog opened scrolled down past its title').toBe(0);
		await expect.element(page.getByRole('button', { name: 'Close' })).toBeInViewport();
	});

	it('says more text sits below until the end is scrolled into view, then drops the cue', async () => {
		await page.viewport(1024, 576);
		weakSpotsOpen.set(true);
		const { baseElement } = await render(WeakSpotsModal);
		const cue = page.getByText('More below ↓');
		await expect.element(cue).toBeVisible();

		const popup = baseElement.querySelector<HTMLElement>('[role="dialog"]')!;
		popup.scrollTop = popup.scrollHeight;
		// Chromium dispatches scroll events in its rendering step, which a page the CI run isn't
		// painting can skip for the whole matcher timeout. Dispatch the event the scroll would have.
		popup.dispatchEvent(new Event('scroll'));
		await expect.element(cue).not.toBeInTheDocument();
		// The cue is sticky with a negative top margin, so removing it makes the dialog 16px taller and
		// leaves the first scroll short of the new end. Scroll to the end again, as a reader would.
		popup.scrollTop = popup.scrollHeight;
		// toBeInViewport reads an IntersectionObserver, which reports only in a rendering step, so on a CI
		// page nobody paints it can read 0 for a link in view. Compare the boxes directly instead.
		const link = page.getByRole('link', { name: 'Trust & Safety' }).element();
		await expect
			.poll(() => {
				const box = link.getBoundingClientRect();
				const frame = popup.getBoundingClientRect();
				return box.top >= frame.top && box.bottom <= frame.bottom && box.bottom <= window.innerHeight;
			}, { message: 'the Trust & Safety link at the end is not inside the scrolled dialog' })
			.toBe(true);
	});
});

// The last caveat ("For anything high-stakes, verify with a
// qualified…") was cut off at 1280x720. The dialog fits the window and the caveat sits below the fold of
// its own scroll area, so it has to stay reachable (the cue saying the text continues is tested at
// 1024x576 above, where the dialog is taller than the window; at 1280x720 it may not be). CUR-3314:
// the cards must not send readers to "looked it up" / "from training" labels no answer shows.
// accessibility.spec.ts opens the dialog from the control beside a real answer (SOL-206).
// e2e-moved: scenarios/weak-spots-dialog-fits.spec.ts › the Where it's weak dialog fits inside the window, and its last line can be scrolled into view
// e2e-moved: scenarios/weak-spots-dialog-fits.spec.ts › the Where it's weak cards point at X-ray and the Web search setting, not at labels no answer shows
// e2e-moved: scenarios/weak-spots-dialog-fits.spec.ts › the Where it's weak dialog shows that more text sits below its fold (CUR-1610)
describe('WeakSpotsModal at 1280x720 (CUR-1610, CUR-3314)', () => {
	afterEach(() => weakSpotsOpen.set(false));

	async function openAt1280() {
		await page.viewport(1280, 720);
		weakSpotsOpen.set(true);
		const { baseElement } = await render(WeakSpotsModal);
		await expect.element(page.getByRole('heading', { name: "Where it's weak" })).toBeVisible();
		return baseElement.querySelector<HTMLElement>('[role="dialog"]')!;
	}

	it('fits inside the window, and its last caveat can be scrolled into view inside the dialog', async () => {
		const popup = await openAt1280();
		const box = popup.getBoundingClientRect();
		expect(box.top, 'the dialog starts above the top of the window').toBeGreaterThanOrEqual(0);
		expect(box.bottom, `the dialog runs past the bottom of the window (${Math.round(box.bottom)}px)`).toBeLessThanOrEqual(720);

		const last = page.getByText(/verify with a qualified/i).element();
		last.scrollIntoView({ block: 'end' });
		const line = last.getBoundingClientRect();
		const after = popup.getBoundingClientRect();
		expect(line.bottom, 'the last caveat is still below the dialog').toBeLessThanOrEqual(after.bottom + 1);
		expect(line.bottom, 'the last caveat is still below the window').toBeLessThanOrEqual(720);
	});

	it('as opened, either shows its last caveat or says more text sits below (CUR-1610 Q2)', async () => {
		const popup = await openAt1280();
		const box = popup.getBoundingClientRect();
		const line = page.getByText(/verify with a qualified/i).element().getBoundingClientRect();
		const lastLineShows = line.bottom <= Math.min(box.bottom, 720);
		const cue = popup.querySelector<HTMLElement>('[data-scroll-cue]');
		const cueShows = !!cue && cue.checkVisibility();
		expect(
			lastLineShows || cueShows,
			'the last caveat is below the fold and nothing in the dialog says the text continues'
		).toBe(true);
	});

	it('points at X-ray and says web search is automatic, not at a + menu switch or labels no answer shows (CUR-4262)', async () => {
		const popup = await openAt1280();
		await expect.element(page.getByText(/Open X-ray under an answer/)).toBeVisible();
		await expect.element(page.getByText(/Alpha searches the web and lists its sources/)).toBeInTheDocument();
		expect(popup.textContent, 'a card still sends people to the + menu for web search').not.toMatch(/\+ menu/);
		expect(popup.textContent, 'a card still says one model answers everything').not.toMatch(/single open model/i);
		expect(popup.textContent, 'a card names a label no answer shows').not.toMatch(/looked it up|from training/i);
	});
});
