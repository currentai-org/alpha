import Button from './button.svelte';
import SpreadHarness from './button-spread.harness.svelte';
import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';

const label = createRawSnippet(() => ({ render: () => '<span>Go</span>' }));

/** The wipe's columns: each flattened at rest, grown to full height on hover. */
const wipeColumns = (el: Element) =>
	[...(el.querySelector('span[aria-hidden="true"]')?.children ?? [])].filter((c) =>
		c.className.includes('origin-bottom')
	);

describe('UiButton hover wipe', () => {
	it.each(['default', 'secondary', 'tertiary', 'light', 'outline-dark', 'outline-salmon'] as const)(
		'gives every %s button the wipe, with its label lifted above it',
		async (variant) => {
			await render(Button, { href: '/go', variant, children: label });
			const link = page.getByRole('link', { name: 'Go' }).element();
			expect(wipeColumns(link)).toHaveLength(3);
			expect(link.querySelector('span.z-1')?.textContent).toBe('Go');
		}
	);

	it('gives a plain <Button> with no variant the wipe, like the gap map panels use it', async () => {
		await render(Button, { href: '/go', children: label });
		expect(wipeColumns(page.getByRole('link', { name: 'Go' }).element())).toHaveLength(3);
	});

	it.each(['outline', 'transparent', 'link', 'cta'] as const)(
		'leaves the %s style without the wipe',
		async (variant) => {
			await render(Button, { href: '/go', variant, children: label });
			expect(wipeColumns(page.getByRole('link', { name: 'Go' }).element())).toHaveLength(0);
		}
	);

	it("keeps a caller's justify-between layout: children land at opposite ends", async () => {
		await render(SpreadHarness);
		const link = page.getByRole('link').element();
		const box = link.getBoundingClientRect();
		const padding = parseFloat(getComputedStyle(link).paddingRight);
		const left = link.querySelector('[data-end="left"]')!.getBoundingClientRect();
		const right = link.querySelector('[data-end="right"]')!.getBoundingClientRect();
		expect(Math.abs(box.right - padding - right.right)).toBeLessThan(2);
		expect(right.left - left.right).toBeGreaterThan(100);
		const wrapper = link.querySelector('span.z-1')!;
		expect(getComputedStyle(wrapper).columnGap).toBe(getComputedStyle(link).columnGap);
	});
});
