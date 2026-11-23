// e2e-product: @site
import { test, expect } from './helpers/test';

// The restyled home hero on a phone. Its image is the page's largest and sits above the
// fold, so it is marked eager and high priority. This checks the browser acts on that: the image's
// request starts while the document is still being parsed, before DOMContentLoaded, it has
// finished decoding by the load event, and its box is painted inside the first screen. The title
// is on that first screen too, and the page never scrolls sideways.

test.use({ viewport: { width: 390, height: 844 } });

test('on a phone the home hero image loads early and is painted inside the first screen, beside the title', async ({
	page
}) => {
	await page.goto('/', { waitUntil: 'load' });
	const img = page.locator('[data-hero-art] img.hero-art-static').first();
	await expect(img, 'the home hero shows no image').toBeVisible();
	await expect(img).toHaveAttribute('loading', 'eager');
	await expect(img).toHaveAttribute('fetchpriority', 'high');

	const timing = await img.evaluate((el: HTMLImageElement) => {
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		const res = performance.getEntriesByType('resource').find((e) => e.name === el.currentSrc) as
			PerformanceResourceTiming | undefined;
		return {
			src: el.currentSrc,
			complete: el.complete,
			naturalWidth: el.naturalWidth,
			requestStart: res?.startTime ?? null,
			domContentLoaded: nav.domContentLoadedEventStart
		};
	});
	expect(timing.complete && timing.naturalWidth > 0, 'the hero image had not decoded by load').toBe(
		true
	);
	expect(
		timing.requestStart,
		`no resource timing for the hero image ${timing.src}, so when it loaded is unknown`
	).not.toBeNull();
	expect(
		timing.requestStart!,
		'the hero image was requested only after the document finished parsing, as a lazy image is'
	).toBeLessThan(timing.domContentLoaded);

	const box = await img.boundingBox();
	expect(box, 'the hero image has no box').not.toBeNull();
	expect(box!.y, 'the hero image starts below the first screen').toBeLessThan(844);
	expect(box!.y + box!.height, 'the hero image sits above the page top').toBeGreaterThan(0);
	expect(box!.x, 'the hero image starts off the right of the screen').toBeLessThan(390);

	const title = page.locator('main h1').first();
	await expect(title).toBeVisible();
	const titleBox = await title.boundingBox();
	expect(titleBox!.y, 'the hero title is not on the first screen').toBeLessThan(844);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow, 'the home page scrolls sideways on a phone').toBeLessThanOrEqual(0);
});

// The restyle at phone width: a dark-blue band across the whole screen, a white title that fits
// the screen with nothing drawn over it, and the hero image inside the band rather than spilling
// onto the white page below. A control then breaks each of those in the page and requires the same
// checks to name every break, so a pass here cannot come from checks that never bite.
type HeroPanel = {
	bg: string;
	left: number;
	width: number;
	top: number;
	bottom: number;
	viewport: number;
	title: { left: number; right: number; top: number; bottom: number } | null;
	titleColor: string | null;
	titleUncovered: boolean;
	image: { top: number; bottom: number; height: number } | null;
};

function panelFaults(m: HeroPanel, darkBlue: string): string[] {
	const faults: string[] = [];
	if (m.bg !== darkBlue) faults.push(`panel is ${m.bg}, not dark blue ${darkBlue}`);
	if (Math.abs(m.left) > 1 || m.width < m.viewport - 1)
		faults.push(`panel spans ${m.left}..${m.left + m.width}, not the ${m.viewport}px screen`);
	if (!m.title) faults.push('panel holds no title');
	else {
		if (m.titleColor !== 'rgb(255, 255, 255)') faults.push(`title is ${m.titleColor}, not white`);
		if (m.title.left < 0 || m.title.right > m.viewport) faults.push('title runs off the screen');
		if (m.title.top < m.top || m.title.bottom > m.bottom)
			faults.push('title spills out of the panel');
		if (!m.titleUncovered) faults.push('something is drawn over the title');
	}
	if (!m.image || m.image.height <= 0) faults.push('panel holds no hero image');
	else if (m.image.top < m.top - 1 || m.image.bottom > m.bottom + 1)
		faults.push(
			`hero image spans ${m.image.top}..${m.image.bottom}, outside the panel ${m.top}..${m.bottom}`
		);
	return faults;
}

test('on a phone the home hero is a full-width dark-blue panel holding the white title and the hero image', async ({
	page
}) => {
	await page.goto('/', { waitUntil: 'load' });
	const panel = page.locator('main section[data-hero-bg]').first();
	await expect(panel, 'the home page has no hero panel').toBeVisible();

	const darkBlue = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--dark-blue)';
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	expect(darkBlue, '--dark-blue resolves to no colour').toMatch(/^rgb/);

	const measure = () =>
		panel.evaluate((section): HeroPanel => {
			const s = section.getBoundingClientRect();
			const h1 = section.querySelector('h1');
			const img = section.querySelector<HTMLImageElement>('[data-hero-art] img.hero-art-static');
			const t = h1?.getBoundingClientRect();
			const i = img?.getBoundingClientRect();
			const hit = t ? document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2) : null;
			return {
				bg: getComputedStyle(section).backgroundColor,
				left: s.left,
				width: s.width,
				top: s.top,
				bottom: s.bottom,
				viewport: document.documentElement.clientWidth,
				title: t ? { left: t.left, right: t.right, top: t.top, bottom: t.bottom } : null,
				titleColor: h1 ? getComputedStyle(h1).color : null,
				titleUncovered: Boolean(h1 && hit && h1.contains(hit)),
				image: i ? { top: i.top, bottom: i.bottom, height: i.height } : null
			};
		});

	const real = await measure();
	expect(panelFaults(real, darkBlue), 'the home hero on a phone breaks the restyle').toEqual([]);

	// Control: paint the band white, lay a box over the title and push the image below the band.
	await panel.evaluate((section) => {
		section.style.backgroundColor = 'rgb(255, 255, 255)';
		const h1 = section.querySelector('h1')!;
		const t = h1.getBoundingClientRect();
		const cover = document.createElement('div');
		Object.assign(cover.style, {
			position: 'fixed',
			left: `${t.left}px`,
			top: `${t.top}px`,
			width: `${t.width}px`,
			height: `${t.height}px`,
			zIndex: '2147483647'
		});
		document.body.append(cover);
		const img = section.querySelector<HTMLImageElement>('[data-hero-art] img.hero-art-static')!;
		img.style.position = 'relative';
		img.style.top = `${section.getBoundingClientRect().height}px`;
	});
	const broken = panelFaults(await measure(), darkBlue);
	expect(broken.join(' | '), 'the control did not register a white band').toContain(
		'not dark blue'
	);
	expect(broken.join(' | '), 'the control did not register a covered title').toContain(
		'drawn over the title'
	);
	expect(broken.join(' | '), 'the control did not register an image below the band').toContain(
		'outside the panel'
	);
});
