// e2e-product: @chat
// e2e-area: @settings
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';

// Forget everything (Data & privacy) and Delete account (Account) were built apart, one a
// default-size button in a hand-drawn box and the other a small button in a Surface row, so the two
// danger zones looked like different apps. Both now render through alpha-ds `DangerRow` in a Surface.
// This measures what a visitor sees on each page: the button's height, the row's padding, the card's
// border.

type Zone = {
	buttonHeight: number;
	rowPadding: string;
	cardBorder: string;
	cardRadius: string;
};

async function measure(page: Page, path: string, button: RegExp | string): Promise<Zone> {
	await page.goto(path, { waitUntil: 'commit' });
	const btn = page.getByRole('button', { name: button });
	await expect(btn, `${path}: the danger button never rendered`).toBeVisible({ timeout: 30_000 });
	const box = await btn.boundingBox();
	if (!box) throw new Error(`${path}: the danger button has no box`);
	const frame = await btn.evaluate((el) => {
		const row = el.closest('[data-danger-row]');
		const card = row?.parentElement;
		if (!row || !card) return null;
		const r = getComputedStyle(row);
		const c = getComputedStyle(card);
		return {
			rowPadding: `${r.paddingTop} ${r.paddingRight} ${r.paddingBottom} ${r.paddingLeft}`,
			cardBorder: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
			cardRadius: c.borderTopLeftRadius
		};
	});
	expect(frame, `${path}: the danger button sits in no DangerRow`).not.toBeNull();
	return { buttonHeight: Math.round(box.height), ...frame! };
}

test(
	'Forget everything and Delete account sit in danger zones of the same button height, padding and frame',
	{ tag: ['@A3', '@CUR-4071'] },
	async ({ page }) => {
		await signInAsFreshUser(page);
		const forget = await measure(page, '/chat/settings/data', /^Forget everything/);
		const del = await measure(
			page,
			'/chat/settings/account',
			'Delete your account, conversations, and sign-in methods'
		);
		expect(forget).toEqual(del);
	}
);
