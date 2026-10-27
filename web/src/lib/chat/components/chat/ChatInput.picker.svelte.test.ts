import ChatInput from './ChatInput.svelte';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';

// Its own file, so no other test's menu or focus state is in this frame when it runs.
const appState = vi.hoisted(() => ({
	page: { data: {} as Record<string, unknown>, url: new URL('http://localhost/chat') }
}));
vi.mock('$app/state', () => appState);
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: async () => {} }));
// CI's headless Chrome reports touch support, which the composer reads as a phone keyboard and so
// never focuses the box on its own. This case is about a desktop keyboard.
vi.mock('$lib/chat/utils/isVirtualKeyboard', () => ({ isVirtualKeyboard: () => false }));

// A large photo's redraw holds the main thread, so a focus that waits a frame lets the keys typed in
// that window land on the page body; the first 30 characters of a question can be lost (CUR-3197).
describe('choosing a photo in the picker', () => {
	it('puts focus in the message box before anything waits, so keys typed during the redraw land there', async () => {
		const { baseElement } = await render(ChatInput, {
			mimeTypes: ['text/plain', 'image/png', 'image/jpeg']
		});
		const input = baseElement.querySelector<HTMLInputElement>('input[type="file"]')!;
		const box = baseElement.querySelector<HTMLTextAreaElement>('textarea')!;
		box.focus();
		expect(document.activeElement, 'this frame refuses focus to the box, so the test below proves nothing').toBe(box);
		box.blur();

		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array([1, 2, 3])], 'note.txt', { type: 'text/plain' }));
		input.files = dt.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));

		expect(document.activeElement, 'the box takes focus only after a wait').toBe(box);
	});
});
