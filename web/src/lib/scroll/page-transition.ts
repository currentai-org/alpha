import { onNavigate } from '$app/navigation';
import { onMount } from 'svelte';
import { on } from 'svelte/events';
import './page-transition.css';

/**
 * A move from one content page to another runs as one View Transition: the old page fades out and
 * the new one fades in, rising into place (page-transition.css), under a header that stays put.
 * Browsers without the API keep the hard cut, as do a reader who asked for reduced motion and a
 * back or forward swipe the browser has already animated itself.
 *
 * Content pages are the ones with the site's header and footer. The chat app keeps its instant
 * switch, and /alpha ⇄ /alpha/demo keeps its own transition (alpha-landing/demo-transition.ts): the
 * demo is a chat page, so the two never claim the same navigation. A Payload page on the chat
 * template is only known once it has rendered, so a transition into one is skipped there.
 *
 * The new page's snapshot is taken at the first frame after the swap, so ScrollSmoother, which
 * places a smoothed page from an afterNavigate callback a microtask later, has already moved it.
 */

const CLASS = 'page-transition';

export function usePageTransition(isContentPage: () => boolean) {
	// Safari's and Chrome's back/forward swipes animate the page themselves; a transition after one
	// would play the change a second time.
	let uaTransition = false;
	onMount(() =>
		on(window, 'popstate', (event) => {
			// Undefined where the browser doesn't report it.
			uaTransition = event.hasUAVisualTransition === true;
		})
	);

	onNavigate((nav) => {
		const swiped = nav.type === 'popstate' && uaTransition;
		uaTransition = false;
		if (
			swiped ||
			!document.startViewTransition ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
			!nav.from ||
			!nav.to ||
			// A `#…` or query change on the same page isn't a page change.
			nav.from.url.pathname === nav.to.url.pathname ||
			!isContentPage() ||
			isChatRoute(nav.to.route.id)
		)
			return;

		document.documentElement.classList.add(CLASS);
		return new Promise<void>((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await nav.complete;
				if (!isContentPage()) transition.skipTransition();
			});
			void transition.finished.finally(() => document.documentElement.classList.remove(CLASS));
		});
	});
}

/** The routes that are the chat app whatever their data (the root layout's `isChatApp`). */
function isChatRoute(id: string | null) {
	return id?.startsWith('/chat') === true || id === '/alpha/demo';
}
