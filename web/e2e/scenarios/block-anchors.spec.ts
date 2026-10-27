// e2e-product: @site
import { test, expect, type APIRequestContext, type Page } from './helpers/test';

// Every page block renders its stored Payload `anchor` as the id, and the first attribute,
// of its outer <section>, and a `#anchor` link lands that section just below the fixed nav bar.
// Content differs per environment, so no page is named here: pages come from the environment's own
// sitemap, and the scroll check runs on the first one with a section far enough down to scroll to.
// Only sections inside <main> count: site chrome such as the footer's newsletter signup carries an
// anchor on every page, and would otherwise satisfy this without any page block rendering one.
const SLUG = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;
const PAGES_TO_TRY = 25;

/** Content pages from the sitemap, as paths on this deployment. Catalog pages have no blocks. */
async function contentPaths(request: APIRequestContext): Promise<string[]> {
	const res = await request.get('/sitemap.xml');
	expect(res.ok(), 'the sitemap did not load').toBe(true);
	const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	// Preview sitemaps can carry another origin, so only the path is kept.
	return locs.map((loc) => new URL(loc).pathname).filter((p) => !/^\/(product|org)\//.test(p));
}

type Section = { id: string; idFirst: boolean; scrollable: boolean };

/** Every `section[id]` in the page's <main>, and whether the page can scroll it up to the nav bar. */
const anchoredSections = (page: Page) =>
	page.evaluate((): { navOffset: number; sections: Section[] } => {
		const probe = document.createElement('div');
		probe.style.height = 'var(--nav-bar-offset)';
		document.body.append(probe);
		const navOffset = probe.getBoundingClientRect().height;
		probe.remove();
		const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
		const sections = [...document.querySelectorAll('main section[id]')].map((el) => {
			const scrollTo = el.getBoundingClientRect().top + window.scrollY - navOffset;
			return {
				id: el.id,
				idFirst: el.outerHTML.startsWith(`<section id="${el.id}"`),
				scrollable: scrollTo > 50 && scrollTo <= maxScroll
			};
		});
		return { navOffset, sections };
	});

test.describe('block anchors', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test(
		'content pages render unique, slug-safe block anchors first on each section, and a #anchor link lands below the nav bar',
		{ tag: '@CUR-2215' },
		async ({ page, request }) => {
			test.setTimeout(180_000);
			const paths = (await contentPaths(request)).slice(0, PAGES_TO_TRY);
			const checked: string[] = [];
			let scrolled = false;

			for (const path of paths) {
				await page.goto(path, { waitUntil: 'domcontentloaded' });
				const { navOffset, sections } = await anchoredSections(page);
				if (sections.length === 0) continue;
				checked.push(path);

				const ids = sections.map((s) => s.id);
				expect(new Set(ids).size, `${path} renders duplicate anchors: ${ids.join(', ')}`).toBe(
					ids.length
				);
				for (const { id, idFirst } of sections) {
					expect(id, `${path}#${id} is not slug-safe`).toMatch(SLUG);
					expect(idFirst, `${path}: id is not the first attribute of <section id="${id}">`).toBe(
						true
					);
				}

				const target = sections.find((s) => s.scrollable);
				if (!target) continue;
				await page.goto(`${path}#${target.id}`, { waitUntil: 'domcontentloaded' });
				await expect
					.poll(
						() =>
							page.evaluate(
								([id, offset]) => {
									const top = document.getElementById(id)?.getBoundingClientRect().top;
									return top === undefined ? null : Math.abs(top - offset);
								},
								[target.id, navOffset] as const
							),
						{
							message: `${path}#${target.id} did not land just below the nav bar (${navOffset}px)`,
							timeout: 10_000
						}
					)
					.toBeLessThanOrEqual(2);
				scrolled = true;
				break;
			}

			expect(
				checked.length,
				`none of the first ${paths.length} content pages in the sitemap renders an anchored block section`
			).toBeGreaterThan(0);
			expect(
				scrolled,
				`no page with anchors (${checked.join(', ')}) has a section far enough down to scroll to`
			).toBe(true);
		}
	);
});
