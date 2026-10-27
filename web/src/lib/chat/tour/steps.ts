/**
 * The guided tour's stops: the features Alpha has and other chat apps don't. Each stop points at an
 * element already on the page, by a selector the component tags for it; a stop whose element isn't
 * on screen (a flag is off, the sidebar is closed on a phone) is left out of that run of the tour.
 *
 * `cta` is the stop's "try it": it clicks `ctaTarget` (or the stop's own element), which opens the
 * real feature, and the tour waits until the person comes back to it.
 */
import { m } from '$lib/paraglide/messages.js';

export interface TourStep {
	id: string;
	/** The element to point at. The first visible match wins (the header renders two footprints). */
	selector: string;
	title: () => string;
	body: () => string;
	cta?: { label: () => string; selector?: string };
	/** The element lives in the sidebar: on a phone, the tour opens the drawer for this stop. */
	inSidebar?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
	{
		id: 'auto',
		selector: '[data-model-pill]',
		title: () => m.tour_autoTitle(),
		body: () => m.tour_autoBody()
	},
	{
		id: 'languages',
		selector: '[data-accessory-pill="languages"]',
		title: () => m.tour_languagesTitle(),
		body: () => m.tour_languagesBody(),
		cta: { label: () => m.tour_languagesCta() }
	},
	{
		id: 'privacy',
		selector: '[data-accessory-pill="privacy"]',
		title: () => m.tour_privacyTitle(),
		body: () => m.tour_privacyBody(),
		cta: { label: () => m.tour_privacyCta() }
	},
	{
		id: 'xray',
		selector: '[data-accessory-pill="xray"]',
		title: () => m.tour_xrayTitle(),
		body: () => m.tour_xrayBody(),
		cta: { label: () => m.tour_xrayCta() }
	},
	{
		id: 'footprint',
		selector: '[data-footprint-trigger]',
		title: () => m.tour_footprintTitle(),
		body: () => m.tour_footprintBody(),
		cta: { label: () => m.tour_footprintCta() }
	},
	{
		id: 'get-involved',
		selector: '[data-get-involved]',
		title: () => m.tour_getInvolvedTitle(),
		body: () => m.tour_getInvolvedBody(),
		cta: { label: () => m.tour_getInvolvedCta(), selector: '[data-get-involved-link]' },
		inSidebar: true
	}
];

export interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** Space kept between the card and the window's edges, and between the card and its element. */
const EDGE = 12;
const GAP = 14;

/**
 * Where the card goes for an element: on whichever side of it (below or above) has more room, centred
 * on it and kept inside the window. When neither side fits, the card sits against the window's bottom
 * edge, over the page, so it is always readable.
 */
export function placeCard(
	target: Rect,
	card: { width: number; height: number },
	viewport: { width: number; height: number }
): { top: number; left: number; side: 'above' | 'below' | 'over' } {
	const below = viewport.height - (target.top + target.height) - GAP - EDGE;
	const above = target.top - GAP - EDGE;
	const centred = target.left + target.width / 2 - card.width / 2;
	const left = Math.round(Math.min(Math.max(centred, EDGE), Math.max(EDGE, viewport.width - card.width - EDGE)));
	if (card.height <= below && below >= above) return { top: Math.round(target.top + target.height + GAP), left, side: 'below' };
	if (card.height <= above) return { top: Math.round(target.top - GAP - card.height), left, side: 'above' };
	if (card.height <= below) return { top: Math.round(target.top + target.height + GAP), left, side: 'below' };
	return { top: Math.round(Math.max(EDGE, viewport.height - card.height - EDGE)), left, side: 'over' };
}

/** The first element matching `selector` that is actually laid out on screen. */
export function visibleTarget(selector: string, root: ParentNode = document): HTMLElement | undefined {
	for (const el of root.querySelectorAll<HTMLElement>(selector)) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return el;
	}
	return undefined;
}
