// e2e-product: @site
import { test, expect } from './helpers/test';

// The quote card's caption on a phone: the logo is capped at 1.2rem tall and 6rem wide
// and keeps its proportions, the role is 13px in the --label-grey token and centres on the logo, and
// a long role wraps inside the card instead of running off it. The home page carries the Quotes
// block on develop's content, which every preview reads; a home page without one fails here rather
// than passing on assertions it never made.

test.use({ viewport: { width: 375, height: 800 } });

const REM = 16;

test(
	'on a phone the quote caption keeps the logo within 1.2rem by 6rem, the role at 13px in --label-grey centred on it, and a long role inside the card',
	{ tag: '@CUR-4613' },
	async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		const section = page.locator('section[data-block="quotes"]');
		await expect(section, 'the home page has no Quotes block to measure').toHaveCount(1, {
			timeout: 15_000
		});
		await section.scrollIntoViewIfNeeded();
		const cards = section.locator('[data-quote-card]');
		await expect(cards.first()).toBeVisible();

		const captions = section.locator('[data-quote-card] figcaption');
		const count = await captions.count();
		expect(count, 'no quote card has a caption').toBeGreaterThan(0);

		// The logo row's image: the organisation's logo, or Current AI's when the quote has none.
		const logoOf = (i: number) => captions.nth(i).locator('p').nth(1).locator('img').first();
		for (let i = 0; i < count; i++) {
			const logo = logoOf(i);
			await logo.scrollIntoViewIfNeeded();
			await expect
				.poll(
					() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
					{
						message: `card ${i + 1}'s logo never loaded`
					}
				)
				.toBe(true);
			const m = await logo.evaluate((img: HTMLImageElement) => {
				const r = img.getBoundingClientRect();
				return {
					width: r.width,
					height: r.height,
					natural: img.naturalWidth / img.naturalHeight,
					fit: getComputedStyle(img).objectFit
				};
			});
			expect(m.height, `card ${i + 1}'s logo is taller than 1.2rem`).toBeLessThanOrEqual(
				1.2 * REM + 0.5
			);
			expect(m.width, `card ${i + 1}'s logo is wider than 6rem`).toBeLessThanOrEqual(6 * REM + 0.5);
			expect(m.height, `card ${i + 1}'s logo collapsed`).toBeGreaterThan(0);
			// Either the box itself has the image's proportions, or object-fit: contain draws it so.
			const boxKeepsRatio = Math.abs(m.width / m.height - m.natural) / m.natural < 0.03;
			expect(
				boxKeepsRatio || m.fit === 'contain',
				`card ${i + 1}'s logo is stretched: box ${m.width.toFixed(1)}×${m.height.toFixed(1)}, image ratio ${m.natural.toFixed(2)}, object-fit ${m.fit}`
			).toBe(true);
		}

		// The role: size, token colour and vertical centre against the logo, on every card that has one.
		const labelGrey = await page.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--label-grey)';
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		expect(labelGrey, '--label-grey resolves to no colour').toMatch(/^rgb/);

		let roles = 0;
		for (let i = 0; i < count; i++) {
			const row = captions.nth(i).locator('p').nth(1);
			const role = row.locator('span').first();
			if ((await role.count()) === 0) continue;
			roles++;
			const r = await row.evaluate((p) => {
				const img = p.querySelector('img')!.getBoundingClientRect();
				const span = p.querySelector('span')!;
				const s = span.getBoundingClientRect();
				const cs = getComputedStyle(span);
				return {
					fontSize: cs.fontSize,
					color: cs.color,
					roleCentre: s.top + s.height / 2,
					logoCentre: img.top + img.height / 2
				};
			});
			expect(r.fontSize, `card ${i + 1}'s role is not 13px on a phone`).toBe('13px');
			expect(r.color, `card ${i + 1}'s role is not the --label-grey colour`).toBe(labelGrey);
			// The role's box, one line or several, has its middle level with the logo's.
			expect(
				Math.abs(r.roleCentre - r.logoCentre),
				`card ${i + 1}'s role sits ${(r.roleCentre - r.logoCentre).toFixed(1)}px off the logo's centre`
			).toBeLessThanOrEqual(1.5);
		}
		expect(
			roles,
			'no quote card shows a role, so size, colour and centring went unchecked'
		).toBeGreaterThan(0);

		// A long role: lengthen the first role shown until it must wrap, then check it stays inside
		// its card and the screen, and the logo beside it keeps its size.
		let withRole = 0;
		while ((await captions.nth(withRole).locator('p').nth(1).locator('span').count()) === 0)
			withRole++;
		const before = await logoOf(withRole).evaluate((img) => img.getBoundingClientRect().width);
		await captions
			.nth(withRole)
			.locator('p')
			.nth(1)
			.locator('span')
			.first()
			.evaluate((span) => {
				span.textContent =
					'Director of open infrastructure and community partnerships, Europe and Africa';
			});
		const wrapped = await cards.nth(withRole).evaluate((card) => {
			const span = card.querySelector('figcaption p:nth-of-type(2) span')!;
			const s = span.getBoundingClientRect();
			const c = card.getBoundingClientRect();
			const img = card.querySelector('figcaption p:nth-of-type(2) img')!.getBoundingClientRect();
			return {
				lines: Math.round(s.height / parseFloat(getComputedStyle(span).fontSize)),
				spanRight: s.right,
				cardRight: c.right,
				pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				logoWidth: img.width,
				logoHeight: img.height
			};
		});
		expect(wrapped.lines, 'the long role did not wrap, so this checks nothing').toBeGreaterThan(1);
		expect(wrapped.spanRight, 'the long role runs past its card').toBeLessThanOrEqual(
			wrapped.cardRight + 0.5
		);
		expect(wrapped.pageOverflow, 'the long role pushed the page into a sideways scroll').toBe(0);
		expect(wrapped.logoHeight, 'the long role squeezed the logo past 1.2rem').toBeLessThanOrEqual(
			1.2 * REM + 0.5
		);
		expect(wrapped.logoWidth, 'the long role squeezed the logo to nothing').toBeGreaterThan(
			Math.min(before, 8)
		);
	}
);

// The author's name above the logo row on a phone: tight leading (1.25), inside its card, and a
// 4px gap (`gap-1`) clear of the logo row, never overlapping it. A control then loosens the leading
// and pulls the logo row up over the name, and requires the same checks to name both breaks.
type NameRow = {
	lineHeight: number;
	fontSize: number;
	nameRight: number;
	cardRight: number;
	gap: number;
};

function nameFaults(rows: NameRow[]): string[] {
	const faults: string[] = [];
	rows.forEach((r, i) => {
		if (Math.abs(r.lineHeight - 1.25 * r.fontSize) > 0.5)
			faults.push(
				`card ${i + 1}'s name leading is ${r.lineHeight}px on ${r.fontSize}px, not tight`
			);
		if (r.nameRight > r.cardRight + 0.5) faults.push(`card ${i + 1}'s name runs past its card`);
		if (r.gap < 0) faults.push(`card ${i + 1}'s logo row overlaps the name by ${-r.gap}px`);
		else if (Math.abs(r.gap - 4) > 1)
			faults.push(`card ${i + 1}'s name sits ${r.gap}px above the logo row, not 4px`);
	});
	return faults;
}

test(
	'on a phone the quote author name has tight leading, stays inside its card and sits 4px clear of the logo row',
	{ tag: '@CUR-4613' },
	async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		const section = page.locator('section[data-block="quotes"]');
		await expect(section, 'the home page has no Quotes block to measure').toHaveCount(1, {
			timeout: 15_000
		});
		await section.scrollIntoViewIfNeeded();
		await expect(section.locator('[data-quote-card]').first()).toBeVisible();

		const measure = () =>
			section.evaluate((s): NameRow[] =>
				[...s.querySelectorAll('[data-quote-card]')]
					.map((card) => {
						const name = card.querySelector('figcaption p:nth-of-type(1)');
						const row = card.querySelector('figcaption p:nth-of-type(2)');
						if (!name || !row) return null;
						const n = name.getBoundingClientRect();
						const cs = getComputedStyle(name);
						return {
							lineHeight: parseFloat(cs.lineHeight),
							fontSize: parseFloat(cs.fontSize),
							nameRight: n.right,
							cardRight: card.getBoundingClientRect().right,
							gap: row.getBoundingClientRect().top - n.bottom
						};
					})
					.filter((r): r is NameRow => r !== null)
			);

		const rows = await measure();
		expect(rows.length, 'no quote card has a name and a logo row').toBeGreaterThan(0);
		expect(nameFaults(rows), 'a quote author name is laid out wrong on a phone').toEqual([]);

		// Control: loose leading on the first name and its logo row pulled up over it.
		await section.evaluate((s) => {
			const card = s.querySelector('[data-quote-card]')!;
			(card.querySelector('figcaption p:nth-of-type(1)') as HTMLElement).style.lineHeight = '2';
			const row = card.querySelector('figcaption p:nth-of-type(2)') as HTMLElement;
			row.style.position = 'relative';
			row.style.top = '-12px';
		});
		const broken = nameFaults(await measure()).join(' | ');
		expect(broken, 'the control did not register loose leading').toContain('not tight');
		expect(broken, 'the control did not register the logo row over the name').toContain('overlaps');
	}
);
