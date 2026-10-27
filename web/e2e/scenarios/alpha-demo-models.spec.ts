// e2e-product: @site
// e2e-area: @provenance
import { expect, test } from './helpers/test';
import { PICKER_BEFORE_WITHDRAWALS } from '../../config/picker';

// The /alpha demo stands in for www, so its model list is www's picker list, not every live catalog
// model (which would put Apertus 1.5 8B and both SEA-LIONs in front of visitors though no
// site offers them).

const NEVER_OFFERED = [
	'swiss-ai/apertus-v1.5-8b',
	'aisingapore/Qwen-SEA-LION-v4-32B-IT',
	'aisingapore/Gemma-SEA-LION-v4-27B-IT'
];

test(
	'CUR-4049: the /alpha demo lists only models www offers, and none no site offers',
	{ tag: ['@F2', '@CUR-4049'] },
	async ({ page, context, baseURL }) => {
		await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: baseURL! }]);
		await page.goto('/alpha');
		await page.locator('[data-hero-try-demo]').click();
		await expect(page).toHaveURL(/\/alpha\/demo/);

		await page.getByRole('button', { name: /^Model:/ }).click();
		await page.getByRole('menuitem', { name: 'Choose a model yourself' }).click();
		const rows = page.locator('[role="menuitemradio"][data-model-id]');
		await expect(rows.first()).toBeVisible();
		const listed = await rows.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute('data-model-id') ?? '')
		);

		for (const id of NEVER_OFFERED) {
			expect(listed, `the demo offers ${id}, which no site's picker serves`).not.toContain(id);
		}
		// A model withdrawn for an outage stays: the demo's answers are recordings (CUR-4162).
		for (const id of listed) {
			expect(
				PICKER_BEFORE_WITHDRAWALS.production,
				`the demo offers ${id}, which www does not`
			).toContain(id);
		}
	}
);
