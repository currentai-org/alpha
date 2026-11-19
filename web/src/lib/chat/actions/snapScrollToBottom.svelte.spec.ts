import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';

vi.mock('$app/state', () => ({ navigating: { to: null } }));

import { revealIfFollowing, snapScrollToBottom } from './snapScrollToBottom';

// an agent approval card that opens below the fold is brought into view, under the chat
// autoscroll's own rule: never after the person has scrolled up to read.

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

async function chat() {
	const scroller = document.createElement('div');
	scroller.style.cssText = 'height:200px;overflow:auto';
	const content = document.createElement('div');
	const answer = document.createElement('div');
	answer.style.height = '600px';
	content.appendChild(answer);
	scroller.appendChild(content);
	document.body.appendChild(scroller);
	// A long agent answer pinned to the top: the action does not follow its growth.
	const action = snapScrollToBottom(scroller, { followBottom: false });
	await tick();
	await new Promise((r) => requestAnimationFrame(r));
	cleanup = () => {
		action.destroy();
		scroller.remove();
	};
	return { scroller, content, answer };
}

function openCard(content: HTMLElement, below: number) {
	const gap = document.createElement('div');
	gap.style.height = `${below}px`;
	const card = document.createElement('div');
	card.style.height = '40px';
	content.append(gap, card);
	return card;
}

function inView(scroller: HTMLElement, el: HTMLElement) {
	const s = scroller.getBoundingClientRect();
	const r = el.getBoundingClientRect();
	return r.top >= s.top && r.bottom <= s.bottom + 1;
}

describe('revealIfFollowing', () => {
	it('scrolls a card that opened below the fold into view while the chat is following the bottom', async () => {
		const { scroller, content } = await chat();
		const card = openCard(content, 500);
		expect(inView(scroller, card), 'the card should start out of sight').toBe(false);

		expect(revealIfFollowing(card)).toBe(true);
		expect(inView(scroller, card)).toBe(true);
	});

	it('leaves the view where it is after the person scrolled up to read', async () => {
		const { scroller, content } = await chat();
		scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
		scroller.scrollTop = 100;
		const card = openCard(content, 500);
		const before = scroller.scrollTop;

		expect(revealIfFollowing(card)).toBe(false);
		expect(scroller.scrollTop).toBe(before);
		expect(inView(scroller, card)).toBe(false);
	});

	it('does nothing for an element outside any chat scroll', () => {
		const loose = document.createElement('div');
		document.body.appendChild(loose);
		expect(revealIfFollowing(loose)).toBe(false);
		loose.remove();
	});
});
