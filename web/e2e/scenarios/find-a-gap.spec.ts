// e2e-product: @site
import { test, expect } from './helpers/test';
import { journeyStep } from './helpers/journeyStep';
import { formatUpdateDate } from '../../src/lib/utils/formatUpdateDate';

// G1 ("As a builder, I can find a real gap and know what it needs").
//
// The first end-to-end walk the gap map has ever had. Every other journey in this suite is a person
// talking to Alpha; this one's persona never opens the chat, and the map is roughly half of what
// this app serves.
//
// WHAT THIS SPEC WILL NOT DO. It stops before the products behind a category verdict, because there
// is nothing to drive: opening a category renders the gap and the maturity stage and links to no
// product page at all (CUR-1591), while the product pages themselves exist and answer 200. Step 5 of
// docs/journeys/g1-find-a-gap.md is written into the table and deliberately unasserted — a spec that
// quietly dropped the step would make the gap invisible, which is the failure this whole loop is for.
//
// WHY THE COUNTS ARE ASSERTED AS PRESENT RATHER THAN AS VALUES. "28 open(ish) products • 5 leading,
// 1 strong" changes every time the catalog is rescored, and a spec pinning today's numbers would go
// red on the map working exactly as intended. What must not change is that a category states how many
// products it was judged from: without that, "no leading option" and "nobody has looked yet" render
// identically, and those are the two states a builder is choosing between. The row counts what it
// draws; the category panel carries the assessed total, closed products included (CUR-732).

const MAP_LANDING = '/map';
const MAP_METHOD = '/map/methodology';

/** The map page's "Version 0.3.0 – last update 25 Sept 2026" → { version, date }. */
function versionStamp(text: string): { version: string; date: string } {
	const m = text.replace(/\s+/g, ' ').match(/Version (\S+) ?[-–] ?last update(?:d|:)? ?(.+)$/i);
	expect(m, `no version and date in "${text}"`).not.toBeNull();
	return { version: m![1], date: m![2].trim() };
}

/** A category row, addressed by the one thing every row says about itself. */
const CATEGORY = /\d+ open\(ish\) products/i;

test(
	'a builder can get from the map to a named gap and to the rule the verdict was reached by',
	{ tag: '@G1' },
	async ({ page }) => {
		// Step 1. The entry point explains itself before showing a grid.
		const explore = page.getByRole('link', { name: /Explore the Gap Map/i }).first();
		await journeyStep(page, 'G1', 1, async () => {
			// From the marketing page, the way a visitor from a talk arrives. Found by where it leads,
			// since its label is CMS copy.
			await page.goto('/', { waitUntil: 'domcontentloaded' });
			const intoMap = page.locator(`main a[href="${MAP_LANDING}"]`).first();
			await expect(
				intoMap,
				'the home page has no way into the gap map, so a visitor from a talk has to be handed the URL'
			).toBeVisible({ timeout: 20_000 });
			await intoMap.click();
			await page.waitForURL(new RegExp(`${MAP_LANDING}$`), { timeout: 30_000 });
			// The h1 is CMS copy ("We are mapping open source AI, and looking for the gaps" since
			// CUR-3904), so this asserts what it has to say, not its wording.
			const premise = page.getByRole('heading', { level: 1 }).first();
			await expect(
				premise,
				'the map landing page does not say what it is, so a visitor arriving from a talk meets a visualization with no premise'
			).toBeVisible({ timeout: 20_000 });
			await expect(
				premise,
				'the map landing heading never says the page maps gaps in open source AI'
			).toHaveText(/open source AI[\s\S]*gap|gap[\s\S]*open source AI/i);

			await expect(
				explore,
				'the landing page offers no way into the map itself, so the entry point is a dead end'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.getByRole('link', { name: /Methodology/i }).first(),
				'the landing page offers no route to how any of this was scored, which is the half that makes the map arguable rather than assertive'
			).toBeVisible({ timeout: 15_000 });
		});

		// The landing and the map page each state the map's version and last update. They read the
		// same dataset, so they must agree: the landing said "V0.3 - Last update: 5 Sept" while the
		// map one click on said "0.3.0 - last updated 25 Sept" (CUR-1631). The landing reads
		// "Gap map 0.3.0 – Updated 3 weeks ago", with the exact date on its <time>.
		const versionLine = /Version\s+\S+\s*[-–]\s*last update/i;
		const landingStamp = page
			.getByRole('region', { name: 'The map in numbers' })
			.locator('p')
			.first();
		const landingText = (await landingStamp.innerText({ timeout: 15_000 })).replace(/\s+/g, ' ');
		const landingVersionMatch = landingText.match(/Gap map (\S+) – Updated/i);
		expect(landingVersionMatch, `no version in the landing's "${landingText}"`).not.toBeNull();
		const landingDate = await landingStamp.locator('time').getAttribute('datetime');
		expect(landingDate, 'the landing states no date for its last update').toBeTruthy();
		const landingVersion = {
			version: landingVersionMatch![1],
			date: formatUpdateDate(landingDate!)
		};

		// Step 2. Inside, how much of the ecosystem is actually scored is stated rather than implied.
		await journeyStep(page, 'G1', 2, async () => {
			await explore.click();
			await page.waitForURL(/\/map\/gap-map/, { timeout: 20_000 });
			// textContent, not innerText: the line is CSS-uppercased, and the date is compared as written.
			const mapVersion = versionStamp(
				(await page.getByText(versionLine).first().textContent({ timeout: 20_000 })) ?? ''
			);
			expect(
				mapVersion,
				'the landing page and the map one click on give different versions or last-update dates for the same dataset'
			).toEqual(landingVersion);
			const scored = page.getByText(/assessed products/i).first();
			await expect(
				scored,
				'the map does not say how much of the ecosystem it has scored, so its silences cannot be read — an unscored category and a category with nothing good in it look the same'
			).toBeVisible({ timeout: 20_000 });
		});

		// Step 3. Categories, each carrying the count it was judged from.
		const categories = page.getByRole('button').filter({ hasText: CATEGORY });
		await journeyStep(page, 'G1', 3, async () => {
			const count = await categories.count();
			expect(
				count,
				'no category on the map states how many products it was judged from, so every verdict on this page is unattributable'
			).toBeGreaterThan(0);
		});

		// Step 4. A category names its stage and its gaps, and says what closing one would take.
		await journeyStep(page, 'G1', 4, async () => {
			// Click the category's own caption, not the row's centre: the row also holds its product
			// squares, and a click on one of those opens that product's panel instead (CUR-732).
			await categories.first().getByText(CATEGORY).click();
			await expect(
				page.getByText(/\d+\s+assessed/i).first(),
				'the category panel does not say how many products the category was judged from, so its verdict is unattributable'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.getByText(/maturity stage/i).first(),
				'opening a category says nothing about how far along it is, so a builder cannot tell a young category from a stuck one'
			).toBeVisible({ timeout: 15_000 });
			const panel = page.getByText(/category gaps/i).first();
			await expect(
				panel,
				'opening a category names no gaps, which is the one thing this project promises a builder will find here'
			).toBeVisible({ timeout: 15_000 });
		});

		// Step 6. The rule behind the verdict, reachable and sourced. This is what "anyone can
		// challenge what the map says" means in practice: disagreeing should mean arguing with a
		// stated method, not with a number.
		await journeyStep(page, 'G1', 6, async () => {
			await page.goto(MAP_METHOD, { waitUntil: 'domcontentloaded' });
			await expect(
				page.getByRole('heading', { name: /^Methodology$/i }).first(),
				'the methodology page does not load, so every score on the map has to be taken on faith'
			).toBeVisible({ timeout: 20_000 });

			const method = ((await page.locator('body').innerText()) ?? '').toLowerCase();
			expect(
				method,
				'the methodology page never says the scores are sourced or which axes they are on, so it explains the map without making it checkable'
			).toMatch(/every score is sourced|three .*axes|openness/);
			expect(
				method,
				'the methodology page states no limits on itself, which is what a reader needs in order to know where disagreeing is reasonable'
			).toContain('limitations');
		});
	}
);

test(
	'a product named on the map has its own page, with a score a reader can trace',
	{ tag: '@G1' },
	async ({ page }) => {
		// "Product view on the develop branch". Reached by URL rather than by clicking, because
		// nothing on the map links here (CUR-1591) — which is itself the finding, not a shortcut.
		const res = await page.goto('/product/pytorch', { waitUntil: 'domcontentloaded' });
		test.skip(
			res?.status() === 404,
			'this catalog entry is not present on this deployment, so there is no product view to walk — a coverage gap, not a verdict on the product'
		);

		await expect(
			page.getByRole('heading', { name: /PyTorch/i }).first(),
			'the product page does not name the product it is about'
		).toBeVisible({ timeout: 20_000 });

		const body = ((await page.locator('body').innerText()) ?? '').toLowerCase();
		expect(
			body,
			'the product page states no score, so the map sends a builder to a page that cannot tell them what the map already decided'
		).toMatch(/overall score|openness/);
		expect(
			body,
			'the product page carries no route back to the map it belongs to, leaving a reader at a dead end'
		).toContain('back to gap map');
		// The openness breakdown printed the scoring rubric's shorthand as its label,
		// "CORE-GATED  ungated", which tells a reader checking the score nothing.
		expect(
			body,
			'the openness breakdown shows the raw rubric key "core-gated" instead of saying whether core features are withheld'
		).not.toContain('core-gated');
		expect(
			body,
			'the openness breakdown does not say whether core features are withheld'
		).toContain('core features withheld');
	}
);
