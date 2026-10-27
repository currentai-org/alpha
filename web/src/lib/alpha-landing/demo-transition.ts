import { onNavigate } from '$app/navigation';
import './demo-transition.css';
import { unlocalizedPath } from '$lib/i18n/routing';

/**
 * Smooth entry into and out of demo mode: /alpha's preview window grows into the full-screen demo
 * window, and shrinks back on exit, using the View Transitions API. Both elements carry
 * `view-transition-name: alpha-demo` (see AlphaDemoShell and /alpha/demo). Browsers without the API,
 * or with reduced motion, keep the instant switch.
 *
 * Call once from each of the two pages (onNavigate registers on the page you're leaving).
 */
const DEMO = '/alpha/demo';
const LANDING = '/alpha';
/** Fired by whichever side mounts the demo client, so the new snapshot shows the app, not a spinner. */
export const DEMO_READY_EVENT = 'alpha-demo:ready';

export function useDemoTransition() {
	onNavigate((nav) => {
		const from = nav.from ? unlocalizedPath(nav.from.url.pathname) : undefined;
		const to = nav.to ? unlocalizedPath(nav.to.url.pathname) : undefined;
		const between = (from === LANDING && to === DEMO) || (from === DEMO && to === LANDING);
		if (
			!between ||
			!document.startViewTransition ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		)
			return;

		if (to === DEMO) sessionStorage.setItem('alpha-demo:from-landing', '1');
		const ready = new Promise<void>((resolve) => {
			window.addEventListener(DEMO_READY_EVENT, () => resolve(), { once: true });
			setTimeout(resolve, 500);
		});
		return new Promise<void>((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await nav.complete;
				await ready;
			});
		});
	});
}

/** Leave demo mode: back through history when we came from /alpha (keeps its scroll), else navigate. */
export function leavesToLanding(): boolean {
	return sessionStorage.getItem('alpha-demo:from-landing') === '1' && history.length > 1;
}
