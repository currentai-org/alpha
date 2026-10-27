import UploadedFile from './UploadedFile.svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/chat'), data: {} } }));

// A 1×1 transparent PNG.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('UploadedFile remove button', () => {
	it('can be reached from the keyboard, is named for the file, and shows once focused', async () => {
		const onclose = vi.fn();
		await render(UploadedFile, {
			file: { type: 'base64', name: 'receipt.png', mime: 'image/png', value: PIXEL },
			onclose
		});
		const remove = page.getByRole('button', { name: 'Remove receipt.png', exact: true });
		await expect.element(remove).toBeInTheDocument();

		// From the thumbnail, which opens the photo, the next tab stop is its remove button.
		page.getByRole('button', { name: 'Open receipt.png', exact: true }).element().focus();
		await userEvent.tab();
		expect(document.activeElement).toBe(remove.element());
		await expect.poll(() => getComputedStyle(remove.element()).opacity).toBe('1');

		await userEvent.keyboard('{Enter}');
		expect(onclose).toHaveBeenCalledOnce();
	});
});

describe('UploadedFile preview title (CUR-4668)', () => {
	it('keeps a 120-character file name on one line inside the dialog at phone width, with the full name in title', async () => {
		await page.viewport(375, 700);
		const name = `${'quarterly-budget-review-final-version-'.repeat(3)}x.txt`.slice(0, 116) + '.txt';
		expect(name.length).toBe(120);
		await render(UploadedFile, {
			file: { type: 'base64', name, mime: 'text/plain', value: btoa('hello') }
		});
		await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();

		const heading = page.getByRole('heading', { name });
		await expect.element(heading).toBeInTheDocument();
		const h3 = heading.element() as HTMLElement;
		expect(h3.getAttribute('title')).toBe(name);

		// One line: the box is no taller than one line of its own text, and the name is cut, not wrapped.
		const style = getComputedStyle(h3);
		expect(style.whiteSpace).toBe('nowrap');
		expect(style.textOverflow).toBe('ellipsis');
		expect(h3.getBoundingClientRect().height).toBeLessThan(parseFloat(style.lineHeight) * 1.5);
		expect(h3.scrollWidth).toBeGreaterThan(h3.clientWidth);

		// Inside the window: the title ends before the viewport's right edge, and before the close button.
		const right = h3.getBoundingClientRect().right;
		expect(right).toBeLessThanOrEqual(375);
		const close = h3.closest('.relative')?.querySelector('button.absolute') as HTMLElement | null;
		if (!close) throw new Error('expected the preview close button');
		expect(right).toBeLessThanOrEqual(close.getBoundingClientRect().left);
	});
});
