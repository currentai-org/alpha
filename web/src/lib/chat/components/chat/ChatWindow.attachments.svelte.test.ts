import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Harness from './ChatWindow.harness.svelte';

// With no CSAM scanner configured the layout sets `attachmentsEnabled` false (layoutData.ts), and
// the server refuses every upload. The chat window must then offer no way to attach a file, so a
// person never picks one only to have it refused. The window is rendered whole, so this covers the
// wiring from the layout flag through offeredMimeTypes to the composer's + menu.
const layout = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('$app/state', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$app/state')>();
	const page = new Proxy(actual.page, {
		get: (target, key) => (key === 'data' ? { ...target.data, ...layout.data } : Reflect.get(target, key))
	});
	return { ...actual, page };
});

// bson-objectid and json5 are CommonJS, which this project's client vitest config does not pre-bundle
// (optimizeDeps in vite.config.ts). The window reaches them through APIClient, conversationId and
// featureAnnouncements; nothing here makes an id or parses JSON5.
vi.mock('json5', () => ({ default: { parse: JSON.parse, stringify: JSON.stringify } }));
vi.mock('bson-objectid', () => ({
	default: class ObjectId {
		static isValid = () => false;
		toString = () => '000000000000000000000000';
	}
}));

const PLUS = '[aria-label^="Add files and tools"]';

// A signed-in person, with photo input on, so only the scanner flag decides whether files are offered.
const signedIn = (attachmentsEnabled: boolean) => ({
	user: { id: 'u1', username: 'someone' },
	loginEnabled: true,
	imageInputEnabled: true,
	documentAttachmentsEnabled: true,
	attachmentsEnabled
});

async function plusMenuRows(attachmentsEnabled: boolean) {
	layout.data = signedIn(attachmentsEnabled);
	const { baseElement } = await render(Harness);
	await expect.poll(() => baseElement.querySelector(PLUS)).not.toBeNull();
	baseElement.querySelector<HTMLElement>(PLUS)!.click();
	await expect.poll(() => baseElement.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
	return {
		baseElement,
		rows: [...baseElement.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
	};
}

describe('ChatWindow with no CSAM scanner configured', () => {
	it('offers no Attach files row and no file input when attachmentsEnabled is false', async () => {
		const { baseElement, rows } = await plusMenuRows(false);
		expect(rows.some((row) => row.startsWith('Attach files')), `rows: ${JSON.stringify(rows)}`).toBe(false);
		expect(baseElement.querySelector('input[type="file"]'), 'a file input is on the page').toBeNull();
	});

	it('offers Attach files for the same signed-in person once a scanner is configured', async () => {
		const { rows } = await plusMenuRows(true);
		expect(rows.some((row) => row.startsWith('Attach files')), `rows: ${JSON.stringify(rows)}`).toBe(true);
	});
});
