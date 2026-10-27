// e2e-product: @site
import { test, expect } from './helpers/test';

// Every design-system Tooltip gave its trigger aria-describedby="", so a screen reader
// heard none of the hover text a sighted user saw (CUR-2378). bits-ui 2.19.0 put the content's id on nothing:
// the popper layer took `id` out of the props and never handed it to the element it rendered, so
// the trigger's aria-describedby pointed at an element with an empty id. 2.19.3 passes it through.
//
// The contract: while a tooltip is open, its trigger is described by the tooltip's own words.
// Checked on the design-system catalog's tooltip page, which renders the component on its own
// with no flag or sign-in in the way; the chat's dictation control asserts the same thing in
// voice-and-attachments.spec.ts.

test(
	"an open tooltip describes its trigger to assistive technology with the tooltip's own words",
	{ tag: '@CUR-2378' },
	async ({ page }) => {
		await page.goto('/designsystem/tooltip');
		const trigger = page.getByRole('button', { name: 'Retry' }).first();
		// The button is in the server HTML before hydration wires its hover, so a hover that lands
		// first opens nothing. Move away and hover again until the tooltip shows.
		await expect(async () => {
			await page.mouse.move(0, 0);
			await trigger.hover();
			await expect(page.getByText('Retry', { exact: true }).last()).toBeVisible({ timeout: 2_000 });
		}, 'hovering the Retry button never opened its tooltip').toPass({ timeout: 20_000 });
		await expect(
			trigger,
			'the open tooltip is not linked to its trigger, so a screen reader never hears the hover text'
		).toHaveAccessibleDescription('Retry');
	}
);
