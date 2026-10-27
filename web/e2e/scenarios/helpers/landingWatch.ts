import type { Page } from '@playwright/test';

// The new-chat landing can flash for a frame (CUR-1594) between
// sign-in completing and the person's conversation coming back, which reads as the conversation being
// lost. A poll misses a single frame, so this installs a MutationObserver as an init script: it runs in
// every document the page loads from here on and reports through a binding that survives navigation.
// It looks for ChatIntroduction's `data-chat-landing` marker, not its headline, which is CMS copy.
//
// Only documents loaded after the call are watched. Sign-in ends in a full page load, so calling this
// just before starting sign-in watches everything after the credential is accepted. A screen reached
// client-side before that (the login chooser itself) is not a new document and is not watched, which is
// what the callers want: the chooser never renders the landing anyway.
//
// Returns the live list of paths on which the landing rendered; assert it is empty once the page has
// settled where it should.
export async function watchForChatLanding(page: Page): Promise<string[]> {
	return watchForSelector(page, '[data-chat-landing]', '__landingSeen');
}

// The same watch for any marker. `binding` names the page binding it reports through, and has to be
// unique per page: Playwright refuses a second binding under a name already exposed.
export async function watchForSelector(
	page: Page,
	selector: string,
	binding: string
): Promise<string[]> {
	const sightings: string[] = [];
	await page.exposeBinding(binding, (_source, path: string) => {
		sightings.push(path);
	});
	await page.addInitScript(
		({ selector, binding }) => {
			const w = window as unknown as Record<string, ((path: string) => void) | undefined>;
			const check = () => {
				if (document.querySelector(selector)) w[binding]?.(location.pathname);
			};
			new MutationObserver(check).observe(document, { subtree: true, childList: true });
		},
		{ selector, binding }
	);
	return sightings;
}
