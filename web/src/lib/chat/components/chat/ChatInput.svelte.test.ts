import ChatInput from './ChatInput.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import { on } from 'svelte/events';
import { LINK_MARK } from '$lib/chat/utils/composerLinks';

// Attach files follows what the composer offers, and the composer offers nothing where the server would
// refuse every upload (offeredMimeTypes, CUR-2725), so the row never appears and then fails.
const appState = vi.hoisted(() => ({
	page: { data: {} as Record<string, unknown>, url: new URL('http://localhost/chat') }
}));
vi.mock('$app/state', () => appState);
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: async () => {} }));

const TEXT_ONLY = ['text/*', 'application/json'];
const TEXT_AND_IMAGES = ['text/plain', 'image/png', 'image/jpeg'];

const PLUS = '[aria-label^="Add files and tools"]';

async function openPlusMenu(props: Record<string, unknown>) {
	const { baseElement } = await render(ChatInput, props);
	baseElement.querySelector<HTMLElement>(PLUS)!.click();
	await expect.poll(() => baseElement.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
	return baseElement;
}

const rows = (baseElement: HTMLElement) =>
	[...baseElement.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());

describe('ChatInput + menu', () => {
	it('offers no Attach files row when no file type is on offer, which is how the server refusing every upload reaches it', async () => {
		const baseElement = await openPlusMenu({ mimeTypes: [] });
		expect(rows(baseElement).some((row) => row?.startsWith('Attach files'))).toBe(false);
	});

	it('offers Attach files for a text-only model that takes text files, not only for one that reads photos', async () => {
		const baseElement = await openPlusMenu({ mimeTypes: TEXT_ONLY });
		expect(rows(baseElement)[0]).toBe('Attach files Uploaded privately to Hugging Face');
	});

	it('holds the tools as flyouts after Attach files, each row showing its current mode', async () => {
		const baseElement = await openPlusMenu({ mimeTypes: TEXT_AND_IMAGES });
		expect(rows(baseElement)).toEqual(['Attach files Uploaded privately to Hugging Face', 'Web search Auto']);
	});

	it('offers a guest Attach files that asks them to sign in, with no file picker behind it', async () => {
		const onSignInToAttach = vi.fn();
		const baseElement = await openPlusMenu({ mimeTypes: [], onSignInToAttach });
		expect(rows(baseElement)[0]).toBe('Attach files Sign in to attach files.');
		expect(baseElement.querySelector('input[type="file"]')).toBeNull();
		baseElement.querySelector<HTMLElement>('[data-testid="attach-sign-in"]')!.click();
		await expect.poll(() => onSignInToAttach.mock.calls.length).toBe(1);
	});

	it('says under Attach files what the chosen model cannot read', async () => {
		const note = 'Apertus reads text and documents, not images. Pick a model that reads images to attach a photo.';
		const baseElement = await openPlusMenu({ mimeTypes: TEXT_ONLY, attachNote: note });
		expect(baseElement.querySelector('[data-testid="attach-note"]')?.textContent).toBe(note);
	});

	// A row that carries a note is three lines tall, so a click on its middle must not land on the
	// "Uploaded privately to Hugging Face" caption, which would swallow it and open nothing.
	it('opens the picker from a click on the middle of a row that carries a note, and not from the Hugging Face link', async () => {
		const { userEvent } = await import('vitest/browser');
		const note = 'ALIA 40B reads text and documents, not photos. Pick a model that reads photos to attach one.';
		const baseElement = await openPlusMenu({ mimeTypes: TEXT_ONLY, attachNote: note });
		const input = baseElement.querySelector<HTMLInputElement>('input[type="file"]')!;
		let opened = 0;
		on(input, 'click', (e) => {
			opened += 1;
			e.preventDefault();
		});
		const link = baseElement.querySelector<HTMLAnchorElement>('[role="menuitem"] a')!;
		on(link, 'click', (e) => e.preventDefault());
		await userEvent.click(link);
		expect(opened, 'the Hugging Face link opened the picker').toBe(0);

		// The caption's own words, "Uploaded privately to", left of the mention: where the row's middle fell.
		const caption = link.closest('[role="menuitem"] .type-caption') as HTMLElement;
		await userEvent.click(caption, { position: { x: 4, y: caption.offsetHeight / 2 } });
		await expect.poll(() => opened, { message: 'a click on the caption words opened no picker' }).toBe(1);
	});

	it('opens one picker that takes every type on offer: text, photos, and PDF or Word where offered (CUR-987)', async () => {
		const baseElement = await openPlusMenu({ mimeTypes: [...TEXT_AND_IMAGES, 'application/pdf'] });
		const input = baseElement.querySelector<HTMLInputElement>('input[type="file"]')!;
		let acceptAtOpen: string | null = null;
		on(input, 'click', (e) => {
			acceptAtOpen = input.getAttribute('accept');
			e.preventDefault();
		});
		baseElement.querySelector<HTMLElement>('[role="menuitem"]')!.click();
		await expect.poll(() => acceptAtOpen).not.toBeNull();
		const accepted = acceptAtOpen!.split(',');
		expect(accepted).toEqual(expect.arrayContaining(['text/plain', 'image/png', 'application/pdf']));
	});
});

// A new visitor starts with web search on auto, the checked option in the + menu's Web search
// flyout, whose captions say what auto does and why to turn it off. The composer shows no Web search
// chip, whatever the mode. Off picked in
// the menu is stored as a choice (webSearchMode.svelte.test.ts reloads it). Was the UI half of
// e2e/scenarios/web-search-default.spec.ts (SOL-206). The store is loaded fresh over empty storage,
// as on a first visit.
// e2e-moved: scenarios/web-search-default.spec.ts › a new visitor starts with web search on auto, and the control says what auto does and why to turn it off (CUR-2030)
describe('web search in the + menu for a new visitor (CUR-2030)', () => {
	it('starts on auto with no chip, captions Auto and Off, and stores Off picked in the menu as a choice', async () => {
		localStorage.removeItem('ap:webSearchMode');
		localStorage.removeItem('ap:webSearchChoice');
		localStorage.removeItem('ap:webSearchAllowed');
		vi.resetModules();
		const { default: FreshChatInput } = await import('./ChatInput.svelte');
		const { page } = await import('vitest/browser');
		try {
			await render(FreshChatInput, { mimeTypes: [] });
			expect(
				document.querySelectorAll('[data-composer-chip]').length,
				'the composer shows a tool chip; web search mode belongs on the + menu row only'
			).toBe(0);
			await page.getByRole('button', { name: /^Add files and tools/ }).click();
			await page.getByRole('menuitem', { name: /^Web search\b/ }).click();
			const group = page.getByRole('group', { name: 'Web search', exact: true });
			const option = (mode: string) => group.getByRole('menuitemradio', { name: new RegExp(`^${mode}\\b`) });
			await expect
				.element(option('Auto'), { message: 'a new visitor did not start on auto' })
				.toHaveAttribute('aria-checked', 'true');
			await expect.element(option('Auto')).toHaveTextContent(/paste a link/i);
			await expect.element(option('Off')).toHaveTextContent(/faster/i);

			// A DOM click, not a locator click (CUR-4195): the locator waits for the flyout to stop moving, and
			// on a loaded runner that wait can outrun bits-ui's 500 ms submenu-intent fallback, which closes the
			// flyout under the pointer. The pick itself is what this test is about.
			(option('Off').element() as HTMLElement).click();
			await expect.poll(() => localStorage.getItem('ap:webSearchChoice'), {
				message: 'Off picked in the menu was not stored as a choice'
			}).toBe('off');
		} finally {
			localStorage.removeItem('ap:webSearchMode');
			localStorage.removeItem('ap:webSearchChoice');
		}
	});
});

// Escape on the tools menu must not leave focus on the closing popup, or the next message's
// keystrokes go nowhere.
describe('closing the + menu', () => {
	it('puts focus in the message box, so what is typed next lands there', async () => {
		const { userEvent } = await import('vitest/browser');
		const { baseElement } = await render(ChatInput, { mimeTypes: [] });
		const tools = baseElement.querySelector<HTMLButtonElement>(PLUS);
		const box = baseElement.querySelector<HTMLTextAreaElement>('textarea');
		expect(tools, 'no + button').not.toBeNull();
		tools!.click();
		await expect.poll(() => baseElement.querySelector('[role="menu"]')).not.toBeNull();
		await userEvent.keyboard('{Escape}');

		await expect.poll(() => document.activeElement).toBe(box);
		await userEvent.keyboard('Bonjour');
		expect(box!.value).toBe('Bonjour');
	});
});

describe('a link in the draft', () => {
	it("draws its site icon beside the address and never over it, at the start of the draft or mid-line", async () => {
		const first = 'https://www.aipotluck.org/';
		const second = 'https://github.com/currentai-org';
		const { baseElement } = await render(ChatInput, {
			value: `${LINK_MARK}www.aipotluck.org/ then ${LINK_MARK}github.com/currentai-org`,
			pastedUrls: new Set([first, second])
		});
		await expect.poll(() => baseElement.querySelectorAll('[data-composer-link]').length).toBe(2);
		for (const link of baseElement.querySelectorAll('[data-composer-link]')) {
			const icon = link.querySelector('img, svg')!.getBoundingClientRect();
			const address = link.querySelector('.composer-link-rest')!.getBoundingClientRect();
			expect(icon.width, 'the icon collapsed to nothing').toBeGreaterThan(8);
			expect(icon.right, `the icon covers the start of ${link.getAttribute('data-composer-link')}`).toBeLessThanOrEqual(
				address.left
			);
		}
	});
});
