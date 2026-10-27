/**
 * The guided tour's state, shared by the tour itself, the account menu's "Take the tour" and the
 * welcome dialog, whose "Take the tour" starts it for a first-time visitor.
 *
 * A visitor who skips the welcome is told where the tour lives: a hint above the sidebar's account
 * row, kept per device (`alpha:tour-hint`) until they dismiss it, open the account menu or take the
 * tour. Where that row isn't on screen (a phone's closed drawer, the collapsed rail), the welcome's
 * caller says so in a toast as well.
 *
 * A stop's "try it" pauses the tour rather than ending it: the person explores the feature, and a
 * "Resume tour" chip takes them on to the next stop.
 */
import { browser } from '$app/environment';
import { trackEvent } from '$lib/analytics';
import { TOUR_STEPS, visibleTarget, type TourStep } from './steps';

const HINT_KEY = 'alpha:tour-hint';

class TourStore {
	/** The stops in this run of the tour: the ones whose element was on screen when it started. */
	steps = $state<TourStep[]>([]);
	index = $state(0);
	active = $state(false);
	paused = $state(false);
	/** The "you can take the tour from here" hint above the account row is showing. */
	hint = $state(false);

	get step(): TourStep | undefined {
		return this.active ? this.steps[this.index] : undefined;
	}

	/** Starts from the first stop. Returns false (and stays closed) when no stop is on screen. */
	start(source: 'welcome' | 'menu'): boolean {
		const steps = TOUR_STEPS.filter((s) => visibleTarget(s.selector));
		if (!steps.length) return false;
		this.dismissHint();
		this.steps = steps;
		this.index = 0;
		this.paused = false;
		this.active = true;
		trackEvent('tour_started', { source, steps: steps.length });
		return true;
	}

	/** Read once the page has hydrated, so the server's render (no hint) and the first client one agree. */
	restoreHint(): void {
		if (!browser) return;
		try {
			if (localStorage.getItem(HINT_KEY) !== null) this.hint = true;
		} catch {
			/* storage unavailable */
		}
	}

	/** The welcome was skipped: point at where the tour lives, until the person has found it. */
	showHint(): void {
		this.hint = true;
		trackEvent('tour_skipped', {});
		try {
			localStorage.setItem(HINT_KEY, new Date().toISOString());
		} catch {
			/* storage unavailable: the hint lasts this page session */
		}
	}

	dismissHint(): void {
		if (!this.hint) return;
		this.hint = false;
		try {
			localStorage.removeItem(HINT_KEY);
		} catch {
			/* storage unavailable */
		}
	}

	next(): void {
		if (this.index >= this.steps.length - 1) return this.finish('completed');
		this.index += 1;
	}

	/** The current stop's element has gone (the sidebar closed on a phone): leave it out of this run. */
	drop(): void {
		if (!this.active) return;
		this.steps = this.steps.filter((_, i) => i !== this.index);
		if (this.index >= this.steps.length) this.finish('completed');
	}

	back(): void {
		if (this.index > 0) this.index -= 1;
	}

	/** "Try it": the feature opens and the tour waits behind a Resume chip. */
	pause(): void {
		const step = this.step;
		if (!step) return;
		trackEvent('tour_cta_clicked', { step: step.id });
		if (this.index >= this.steps.length - 1) return this.finish('completed');
		this.paused = true;
	}

	/** Back from trying a feature: on to the stop after it. */
	resume(): void {
		this.paused = false;
		this.next();
	}

	finish(how: 'completed' | 'dismissed'): void {
		if (!this.active) return;
		trackEvent(how === 'completed' ? 'tour_completed' : 'tour_dismissed', {
			step: this.step?.id,
			reached: this.index + 1,
			steps: this.steps.length
		});
		this.active = false;
		this.paused = false;
	}
}

export const tour = new TourStore();
