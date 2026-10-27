// e2e-product: @site
import { test, expect, type APIRequestContext } from './helpers/test';
import postgres from 'postgres';
import { installPageFaultHeader } from './helpers/faultInjection';

// G1, the gap map served from the os-ai-map database (CUR-1901). The map, the entity pages, the
// alias redirects and the freshness probe all read the database now, so each is driven here
// against a real deployment rather than asserted from a unit test around it.
//
// Run against a deployment whose environment has GAP_MAP_DATABASE_URL. Without it these pages
// answer 500, which is the failure this spec is named for.
//
// The alias pairs are real rows in the `aliases` table (amazon-nova-pro → amazon-nova,
// alibaba → alibaba-cloud). If os-ai-map retires one, pick another from
// `select alias, kind, canonical from "os-ai-map".aliases`.

const PRODUCT_ALIAS = { from: 'amazon-nova-pro', to: 'amazon-nova' };
const ORG_ALIAS = { from: 'alibaba', to: 'alibaba-cloud' };

/** One request with redirects NOT followed, so a single 308 hop can be asserted as such. */
async function hop(request: APIRequestContext, path: string) {
	const res = await request.get(path, { maxRedirects: 0 });
	return { status: res.status(), location: res.headers()['location'] ?? null };
}

test.describe('gap map served from the database', { tag: '@G1' }, () => {
	test(
		'the map renders its categories, each stating how many products it draws',
		{ tag: '@live' },
		async ({ page }) => {
			const res = await page.goto('/map/gap-map', { waitUntil: 'domcontentloaded' });
			expect(res?.status(), `/map/gap-map answered ${res?.status()}`).toBe(200);
			const categories = page.getByRole('button').filter({ hasText: /\d+ open\(ish\) products/i });
			await expect(
				categories.first(),
				'the map rendered no category cells: the dataset did not load from the database'
			).toBeVisible({ timeout: 30_000 });
			expect(await categories.count()).toBeGreaterThan(10);
			await expect(
				page.getByText(/assessed products/i).first(),
				'the headline figures are missing: the root layout could not read gapMapMeta'
			).toBeVisible();
		}
	);

	test('a product page and an organization page render from the database', async ({ page }) => {
		const product = await page.goto('/product/vllm', { waitUntil: 'domcontentloaded' });
		expect(product?.status(), '/product/vllm did not answer 200').toBe(200);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('vLLM');

		const org = await page.goto('/org/meta', { waitUntil: 'domcontentloaded' });
		expect(org?.status(), '/org/meta did not answer 200').toBe(200);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Meta');
	});

	// os-ai-map holds one axis open on Llama (CUR-2355), publishing basis
	// `partial`. A product re-checked this week must never read as the commit-date fallback, whether
	// the hold is still open ("Verified …, except …") or has since settled ("Verified …").
	test('a product re-observed this week reads as verified, never as "last edited, not re-checked"', async ({
		page
	}) => {
		const res = await page.goto('/product/llama', { waitUntil: 'domcontentloaded' });
		expect(res?.status(), '/product/llama did not answer 200').toBe(200);
		const line = page.getByTestId('freshness-line');
		await expect(line).toHaveText(/^Verified \d{4}-\d{2}-\d{2}/);
		await expect(line).not.toContainText('last edited');
	});

	// A database over its plan quota must not turn every product and org page into a 500 (CUR-2304).
	// The `gap_map_db_down` fault fails the read on this one request, and the page must still render
	// from the committed snapshot. `no-store` is the proof the fault reached the server and the
	// snapshot answered: a database render is sent with an hour of CDN caching. The query string
	// keeps the CDN from answering with a copy it cached before this request.
	test('a product page still renders from the committed snapshot when the database read fails', async ({
		page
	}) => {
		await installPageFaultHeader(page, 'gap_map_db_down', '/product/vllm');
		const res = await page.goto(`/product/vllm?cur2304=${Date.now()}`, {
			waitUntil: 'domcontentloaded'
		});
		expect(res?.status(), 'with the database read failing, /product/vllm did not answer 200').toBe(
			200
		);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('vLLM');
		expect(
			res?.headers()['cache-control'],
			'the page was not rendered from the snapshot: either the fault never reached the server, or it rendered from the database'
		).toBe('no-store');
	});

	// The three tests below only make requests. They take `request` rather than `page.request` so no
	// page opens: a page records a video, and a page that never navigates records a blank tab the
	// journey gallery would show as a white tile (CUR-1623).
	test('a retired product slug lands on its live slug in one 308, on both prefixes', async ({
		request
	}) => {
		const expected = `/product/${PRODUCT_ALIAS.to}`;
		for (const path of [`/product/${PRODUCT_ALIAS.from}`, `/map/product/${PRODUCT_ALIAS.from}`]) {
			const { status, location } = await hop(request, path);
			expect(status, `${path} did not 308`).toBe(308);
			expect(new URL(location!, 'http://x').pathname, `${path} redirected elsewhere`).toBe(
				expected
			);
		}
		expect((await hop(request, expected)).status, `${expected} is not live`).toBe(200);
	});

	test('a retired organization slug lands on its live slug in one 308, on both prefixes', async ({
		request
	}) => {
		const expected = `/org/${ORG_ALIAS.to}`;
		for (const path of [`/org/${ORG_ALIAS.from}`, `/map/org/${ORG_ALIAS.from}`]) {
			const { status, location } = await hop(request, path);
			expect(status, `${path} did not 308`).toBe(308);
			expect(new URL(location!, 'http://x').pathname, `${path} redirected elsewhere`).toBe(
				expected
			);
		}
		expect((await hop(request, expected)).status, `${expected} is not live`).toBe(200);
	});

	test('/api/data-freshness names the publish run the database holds', async ({
		request
	}, info) => {
		const res = await request.get('/api/data-freshness');
		expect(res.status(), 'the freshness probe could not read the gap map database').toBe(200);
		const body = await res.json();
		expect(body.run_id, 'no run_id: the probe is not reading publish_runs').toMatch(
			/^[0-9a-f]{32}$/
		);
		expect(['db', 'static-json']).toContain(body.version_source);

		const url = process.env.GAP_MAP_DATABASE_URL;
		if (!url) {
			info.annotations.push({
				type: 'gap-map-db-unreachable',
				description:
					'GAP_MAP_DATABASE_URL is not set in the runner, so run_id was checked for shape only, ' +
					'not compared against publish_runs.'
			});
			return;
		}
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			const [latest] = await sql<{ run_id: string }[]>`
				select run_id from "os-ai-map".publish_runs order by published_at desc limit 1`;
			expect(body.run_id, 'the deployment serves a different publish than the database holds').toBe(
				latest.run_id
			);
		} finally {
			await sql.end();
		}
	});
});
