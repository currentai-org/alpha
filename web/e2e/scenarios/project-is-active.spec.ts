// e2e-product: @site
import { test, expect } from './helpers/test';
import { journeyStep } from './helpers/journeyStep';

// W1 ("I can see the project is active, and what has changed recently").
//
// The judgment a stranger makes in about thirty seconds, and the one that decides whether any other
// journey in this suite is ever walked by a real person. The persona has heard the pitch once and is
// asking the narrow question — is anyone still working on this — rather than whether it is good.
//
// WHY SPECIFICITY IS THE ASSERTION AND NOT VOLUME. A page with twenty posts saying "general
// improvements and bug fixes" reads to a wary visitor as the absence of news rather than as news, so
// counting posts would pass on exactly the failure this journey is about. What is checked instead is
// that the headlines name particular things. The set below is drawn from the live page, so it is a
// check that the editorial habit held, not a pin on today's copy.

test(
	'a stranger can tell in one hop that the project shipped something recently, and what',
	{ tag: ['@W1', '@CUR-3700'] },
	async ({ page }) => {
		// Step 1 and 2. The home page carries a dated sign of recent activity, and a named route to it.
		// Since CUR-2542 that sign is the hero's updates tile ("11 Updates / In the past 8 weeks"). It
		// renders only when the window holds at least one update, so a quiet stretch fails here too:
		// the visitor would see nothing dated either (CUR-2561).
		// A cold render that waits more than 1s on the CMS serves the tile's fallback, an empty window,
		// and the tile hides by design (CUR-2254). The fetch carries on and warms the cache, so the
		// contract is: a cold render never shows a wrong count, and the tile is there once the CMS has
		// answered (CUR-3700).
		await journeyStep(page, 'W1', 1, async () => {
			await page.goto('/', { waitUntil: 'domcontentloaded' });
			const tile = page.getByRole('link', { name: /\d+\s+updates?\b.*in the past/i }).first();
			await expect(
				page.getByRole('link', { name: /\b0\s+updates?\b/i }),
				'the home page says nothing has happened, when a render without the CMS answer should show no tile at all'
			).toHaveCount(0);
			if (!(await tile.isVisible())) {
				test.info().annotations.push({
					type: 'cold-render',
					description:
						'the first render of / served the updates fallback; reloaded until the CMS answer was cached'
				});
				await expect(async () => {
					await page.reload({ waitUntil: 'domcontentloaded' });
					await expect(tile).toBeVisible({ timeout: 2_000 });
				}).toPass({ timeout: 20_000 });
			}
			await expect(
				tile,
				'the home page shows no sign that anything has happened recently, so a visitor has to go looking for evidence the project is alive'
			).toBeVisible({ timeout: 20_000 });
		});

		const updates = page.getByRole('link', { name: /^Updates$/i }).first();
		await journeyStep(page, 'W1', 2, async () => {
			await expect(
				updates,
				'nothing in the navigation leads to what has shipped, so the only evidence of life is whatever the home page happens to show'
			).toBeVisible({ timeout: 15_000 });
		});

		// Step 3. Real, specific, dated changes. Each update is a card: a link to the post holding its
		// headline, its category's icon and label, and when it was posted (CUR-3862's redesign). The
		// page's own heading copy is the CMS's to change, so the h1 is held only to being about updates
		// (CUR-3879).
		const tiles = page.locator('a[href*="updates/"]').filter({ has: page.locator('h3') });
		await journeyStep(page, 'W1', 3, async () => {
			await updates.click();
			await page.waitForURL(/\/updates/, { timeout: 20_000 });
			await expect(
				page.getByRole('heading', { level: 1, name: /\bupdates?\b/i }),
				'the updates page does not present itself as a record of updates'
			).toBeVisible({ timeout: 20_000 });
			await expect(
				tiles.first(),
				'the updates page lists nothing, so a visitor learns only that the page exists'
			).toBeVisible({ timeout: 20_000 });

			const cards = (await tiles.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
			expect(
				cards.length,
				'the updates page lists three updates or fewer, which reads as a project that has barely started'
			).toBeGreaterThan(3);

			// An undated update says nothing about whether the project is alive now.
			const posted =
				/\b(\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago|today|yesterday|just now)\b|\b\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}\b|\b[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}\b/i;
			const undated = cards.filter((c) => !posted.test(c));
			expect(
				undated,
				'an update on the list does not say when it was posted, so a visitor cannot tell old news from new'
			).toEqual([]);

			const titles = (await tiles.locator('h3').allInnerTexts()).map((t) =>
				t.replace(/\s+/g, ' ').trim()
			);

			// The posts name particular things rather than describing change in general. One match is
			// enough: this is asserting the habit, not auditing every headline.
			const specific = titles.filter((t) =>
				/alpha|gap map|model|apertus|safety|retrieval|homepage|joins/i.test(t)
			);
			expect(
				specific.length,
				`the updates read as generic change rather than as particular changes, which a visitor deciding whether this project is alive cannot use. Headlines were: ${titles.slice(0, 8).join(' | ')}`
			).toBeGreaterThan(0);
		});

		// Step 4. A reader interested in one product is not made to read about the other.
		await journeyStep(page, 'W1', 4, async () => {
			// Each filter is a link to its own URL; scoped to the filter row, since the site header links
			// to Alpha and the Gap Map too.
			const filterRow = page.getByRole('navigation', { name: 'Filter updates by category' });
			const filters = filterRow
				.getByRole('link')
				.filter({ hasText: /^\s*(All updates|Alpha|Gap Map)\s*$/i });
			expect(
				await filters.count(),
				'the updates page offers no way to narrow to one product, so a reader following the chat also reads the map and the other way round'
			).toBeGreaterThan(1);

			// The critic samples this recording at one frame per second, and the click below
			// landed about half a second after the list rendered, so the frames it read as "All" already
			// showed the Alpha-only list and it graded the filter as changing nothing (CUR-1926). Hold the unfiltered
			// list long enough to be photographed twice, the same dwell CUR-1818 added after the click.
			await page.waitForTimeout(2_000);

			// Presence of the buttons proves nothing about whether pressing one does anything —
			// the count check above would pass identically whether "Alpha" narrows the list or is wired to
			// nothing (CUR-1818). Click it and check what the list looks like afterward.
			const unfilteredTiles = await tiles.allInnerTexts();
			const alphaFilter = filterRow.getByRole('link', { name: 'Alpha', exact: true });
			await alphaFilter.click();
			await expect(
				alphaFilter,
				'clicking "Alpha" never marked the control as the active filter, so a screen-reader user has no way to tell which filter (if any) is applied'
			).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });

			// The filter is server-side and the list is paged, so the Alpha list is page 1 of the Alpha
			// updates: it can hold Alpha updates older than anything on page 1 of every update, and as
			// many tiles. The contract is what each tile is, and that the list changed.
			await expect(
				page,
				'picking "Alpha" never put the filter in the URL, so the narrowed list cannot be linked to or reloaded'
			).toHaveURL(/[?&]category=/, { timeout: 10_000 });
			await expect(
				tiles.first(),
				'picking "Alpha" emptied the list entirely, which is a different failure than not narrowing but is just as broken for a reader who wanted to see Alpha updates'
			).toBeVisible({ timeout: 10_000 });
			const filteredTiles = await tiles.all();
			for (const tile of filteredTiles) {
				await expect(
					tile.getByRole('img', { name: 'Alpha', exact: true }),
					`filtering to "Alpha" still listed an update from another product: ${await tile.innerText()}`
				).toHaveCount(1);
			}
			expect(
				await tiles.allInnerTexts(),
				`picking "Alpha" left the list exactly as it was under "All updates" — the filter accepted the click and changed nothing a reader can see`
			).not.toEqual(unfilteredTiles);

			// Once the filtered list is on screen the assertions above resolve at once, and
			// step 5 navigates away immediately after (CUR-1818). Without a dwell,
			// every sampled frame showed "All" selected, because nothing held the narrowed state on screen
			// long enough to be photographed. Same dwell shape journey-gallery.spec.ts already uses.
			await page.waitForTimeout(1_000);
		});

		// Step 5. What is coming, separated from what has happened.
		await journeyStep(page, 'W1', 5, async () => {
			await page.goto('/roadmap', { waitUntil: 'domcontentloaded' });
			const roadmap = ((await page.locator('body').innerText()) ?? '').toLowerCase();
			// The Timeline block labels the upcoming column "Next up"; older content said "Up next" (CUR-2863).
			for (const [section, label] of [
				['shipped', /shipped/],
				['in progress', /in progress/],
				['next up', /next up|up next/]
			] as const) {
				expect(
					roadmap,
					`the roadmap does not separate "${section}" from the rest, so it reads as a wish list and says nothing about whether the project is moving`
				).toMatch(label);
			}
		});
	}
);

// After an idle spell the first visitor to `/` watched a blank tab for 3-4s while a cold
// function rendered (CUR-1597). The CDN now answers `/` from its last render, so the contract a visitor feels
// is that a second request is served from the edge rather than rendered again. That a draft preview
// is never offered to the edge is pinned in page.server.spec.ts: a spec holds no preview secret.
test(
	'the home page is served from the edge after the first render (CUR-1597)',
	{ tag: '@W1' },
	async ({ page }) => {
		const first = await page.request.get('/');
		expect(first.status()).toBe(200);
		const cacheControl = first.headers()['cache-control'];

		if (!first.headers()['x-vercel-id']) {
			// Only Vercel's edge caches; a local server answers the header and nothing else.
			test.info().annotations.push({ type: 'no-edge', description: 'not behind Vercel' });
			expect(
				cacheControl,
				'the home page is not offered to the CDN, so every visitor after an idle spell waits on a cold render'
			).toMatch(/^public, max-age=0, s-maxage=(60|5), stale-while-revalidate=86400$/);
		} else {
			// Vercel consumes `s-maxage` and `stale-while-revalidate` and strips them before the response
			// leaves the edge, so a browser sees `public, max-age=0`; the edge's own verdict is the check.
			expect(cacheControl, 'the home page is marked private, so no edge may keep it').toMatch(
				/^public\b/
			);
			await expect(async () => {
				const again = await page.request.get('/');
				expect(
					again.headers()['x-vercel-cache'],
					'a repeat request for / was rendered again instead of served from the edge'
				).toMatch(/^(HIT|STALE)$/);
			}).toPass({ timeout: 15_000 });
		}
	}
);
