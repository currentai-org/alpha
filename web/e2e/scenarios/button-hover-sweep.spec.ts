// e2e-product: @site
import { test, expect, type Locator, type Page } from './helpers/test';
import { pageWithBlock } from './helpers/contentPages';

// The banner's "Go to roadmap" button (the `light` variant on the dark promo banner) and the
// homepage's salmon button (`secondary`) are meant to play one hover animation that differs only in
// colour: the three-column wipe grows, the label recolours, and a 2px frame in the button's resting
// colour appears on `::after`. reported the banner button mixing an outline animation with the
// wipe. This hovers both and compares what the browser computes once the hover has settled, plus the
// button's own background on every frame of the hover, which is where a mixed outline/fill animation
// would show.

test.use({ viewport: { width: 1440, height: 900 } });

const TRANSITION_PROPS = [
	'transitionProperty',
	'transitionDuration',
	'transitionTimingFunction',
	'transitionDelay'
] as const;

type Snapshot = {
	/** Button body: resting colours, then the sampled backgrounds across the whole hover. */
	restBackground: string;
	button: Record<string, string>;
	wipe: { scaleY: number; fill: string; transitions: Record<string, string>[] };
	label: { color: string; transitions: Record<string, string> };
	frame: { position: string; borderWidth: string; borderColor: string; inset: string[] } & {
		transitions: Record<string, string>;
	};
	backgroundsSeen: string[];
};

/** Reads the computed state of a sweeping button. Runs in the page. */
function read(button: Locator): Promise<Omit<Snapshot, 'restBackground' | 'backgroundsSeen'>> {
	return button.evaluate((el, props) => {
		const pick = (cs: CSSStyleDeclaration) => Object.fromEntries(props.map((p) => [p, cs[p]]));
		const scaleY = (cs: CSSStyleDeclaration) => {
			if (cs.scale && cs.scale !== 'none') {
				const parts = cs.scale.split(' ');
				return Number(parts[parts.length > 1 ? 1 : 0]);
			}
			return new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform).d;
		};
		const cols = [...el.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"] > span')];
		const label = el.querySelector<HTMLElement>(':scope > span:not([aria-hidden])')!;
		const frame = getComputedStyle(el, '::after');
		const btn = getComputedStyle(el);
		return {
			button: pick(btn),
			wipe: {
				scaleY: Math.min(...cols.map((c) => scaleY(getComputedStyle(c)))),
				fill: getComputedStyle(cols[0]).backgroundColor,
				transitions: cols.map((c) => pick(getComputedStyle(c)))
			},
			label: { color: getComputedStyle(label).color, transitions: pick(getComputedStyle(label)) },
			frame: {
				position: frame.position,
				borderWidth: frame.borderTopWidth,
				borderColor: frame.borderTopColor,
				inset: [frame.top, frame.right, frame.bottom, frame.left],
				transitions: pick(frame)
			}
		};
	}, TRANSITION_PROPS);
}

/**
 * Hovers the button while sampling its own background on every animation frame, and returns the
 * resting background, the state once the wipe has fully grown, and every background seen on the way.
 */
async function hoverAndRead(page: Page, button: Locator): Promise<Snapshot> {
	await button.scrollIntoViewIfNeeded();
	const restBackground = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
	const rest = await read(button);
	expect(rest.wipe.scaleY, 'the wipe is already grown before the hover').toBe(0);
	expect(rest.frame.borderColor, 'the frame shows before the hover').toBe('rgba(0, 0, 0, 0)');

	await button.evaluate((el) => {
		const seen = new Set<string>();
		const w = window as unknown as { __seen: Set<string>; __stop: boolean };
		w.__seen = seen;
		w.__stop = false;
		const tick = () => {
			seen.add(getComputedStyle(el).backgroundColor);
			if (!w.__stop) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await button.hover();
	await expect
		.poll(async () => (await read(button)).wipe.scaleY, {
			message: 'the hover never grew the wipe to full height'
		})
		.toBe(1);
	// The frame and label colours settle with the wipe; wait on the frame being drawn.
	await expect
		.poll(async () => (await read(button)).frame.borderColor, {
			message: 'the hover never drew the frame'
		})
		.not.toBe('rgba(0, 0, 0, 0)');
	const settled = await read(button);
	const backgroundsSeen = await page.evaluate(() => {
		const w = window as unknown as { __seen: Set<string>; __stop: boolean };
		w.__stop = true;
		return [...w.__seen];
	});
	return { restBackground, backgroundsSeen, ...settled };
}

async function bannerButton(page: Page, request: Parameters<typeof pageWithBlock>[0]) {
	// The blue banner: the promo banner's card in its dark tone.
	const sel = '[data-block="promo-banner"] .bg-dark-blue [data-slot="button"]:visible';
	const found = await pageWithBlock(request, 'promo-banner');
	for (const path of ['/updates', '/map', '/about', found].filter((p): p is string => !!p)) {
		await page.goto(path);
		if ((await page.locator(sel).count()) > 0) return page.locator(sel).first();
	}
	return null;
}

// Sweeping pills are a `button` slot, except the header nav's, which a navigation-menu link wraps
// (the header's desktop Contribute is the homepage's only visible salmon one).
const SWEEPERS = '[data-slot="button"], [data-slot="navigation-menu-link"]';

/**
 * The homepage's salmon pill: the `secondary` sweeping button (no border, three wipe columns, hover
 * frame `after:border-secondary`), outside the footer, on screen. Returns what it read of every button
 * on the page too, so a miss names what was there instead of guessing at the page's shape.
 */
async function homepageSalmonButton(page: Page) {
	await page.goto('/');
	const read = () =>
		page.evaluate(
			(selector) =>
				[...document.querySelectorAll<HTMLElement>(selector)].map((b, i) => {
					const cs = getComputedStyle(b);
					const box = b.getBoundingClientRect();
					const columns = b.querySelectorAll(':scope > span[aria-hidden="true"] > span').length;
					const secondary = /(^|\s)hover:after:border-secondary(\s|$)/.test(b.className);
					return {
						i,
						text: (b.textContent ?? '').trim().slice(0, 30),
						where: b.closest('footer') ? 'footer' : b.closest('header') ? 'header' : 'page',
						background: cs.backgroundColor,
						border: cs.borderTopWidth,
						columns,
						secondary,
						visible: box.width > 0 && box.height > 0 && cs.visibility !== 'hidden',
						// Why a button is not visible: its box, its own visibility and the first ancestor
						// that is not displayed, hidden or transparent.
						box: [
							Math.round(box.x),
							Math.round(box.y),
							Math.round(box.width),
							Math.round(box.height)
						],
						visibility: cs.visibility,
						opacity: cs.opacity,
						hiddenBy: (() => {
							for (let a: HTMLElement | null = b; a; a = a.parentElement) {
								const s = getComputedStyle(a);
								if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
									return `${a.tagName.toLowerCase()}.${a.className.toString().slice(0, 60)} display=${s.display} visibility=${s.visibility} opacity=${s.opacity}`;
								}
							}
							return null;
						})(),
						match: !b.closest('footer') && secondary && cs.borderTopWidth === '0px' && columns === 3
					};
				}),
			SWEEPERS
		);
	let seen = await read();
	await expect
		.poll(async () => (seen = await read()).filter((c) => c.match && c.visible).length, {
			message: 'waiting for the homepage salmon sweeping button'
		})
		.toBeGreaterThan(0)
		.catch(() => undefined);
	const hit = seen.find((c) => c.match && c.visible);
	if (!hit) {
		throw new Error(
			`the homepage has no visible salmon sweeping button. Buttons read on ${page.url()} at ${page.viewportSize()?.width}px wide:\n` +
				seen.map((c) => JSON.stringify(c)).join('\n')
		);
	}
	return page.locator(SWEEPERS).nth(hit.i);
}

test(
	'the banner "Go to roadmap" button and the homepage salmon button hover with the same wipe and frame',
	{ tag: '@CUR-4254' },
	async ({ page, request }) => {
		const banner = await bannerButton(page, request);
		expect(
			banner,
			'no page in this environment has a dark-tone promo banner with a button'
		).not.toBeNull();
		const bannerHover = await hoverAndRead(page, banner!);

		const salmon = await homepageSalmonButton(page);
		const salmonHover = await hoverAndRead(page, salmon);

		// One clean animation: the button's own background never changes on the way, so no fill
		// animation runs under the wipe (the report was an outline and a fill animating together).
		for (const [name, hover] of [
			['banner', bannerHover],
			['homepage salmon', salmonHover]
		] as const) {
			expect(
				hover.backgroundsSeen,
				`the ${name} button's own background changed during the hover`
			).toEqual([hover.restBackground]);
			expect(hover.wipe.scaleY, `the ${name} wipe did not reach full height`).toBe(1);
			expect(
				hover.frame.borderColor,
				`the ${name} frame is not drawn in the button's resting colour`
			).toBe(hover.restBackground);
			expect(hover.frame.borderWidth, `the ${name} frame is not 2px`).toBe('2px');
		}

		// The same animation: identical wipe, label and frame transitions and frame geometry.
		expect(bannerHover.wipe.transitions, 'the wipe columns transition differently').toEqual(
			salmonHover.wipe.transitions
		);
		expect(bannerHover.label.transitions, 'the label transitions differently').toEqual(
			salmonHover.label.transitions
		);
		expect(bannerHover.frame.transitions, 'the ::after frame transitions differently').toEqual(
			salmonHover.frame.transitions
		);
		expect({ ...bannerHover.frame, borderColor: '', transitions: '' }).toEqual({
			...salmonHover.frame,
			borderColor: '',
			transitions: ''
		});
		for (const p of TRANSITION_PROPS) {
			expect(bannerHover.button[p], `the button body's ${p} differs`).toBe(salmonHover.button[p]);
		}
		// They differ only in colour: both wipe to dark blue.
		expect(bannerHover.wipe.fill).toBe('rgb(20, 46, 62)');
		expect(salmonHover.wipe.fill).toBe('rgb(20, 46, 62)');
	}
);
