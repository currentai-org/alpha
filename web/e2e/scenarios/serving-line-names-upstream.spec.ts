// e2e-product: @chat
// e2e-area: @provenance
import { test, expect } from './helpers/test';

// This spec is about the first-run welcome, so it meets the welcome itself rather than through the shared handler (SOL-343).
test.use({ welcome: 'show' });

// An instance that reaches inference through its own Folkways adapter (a demo instance, and every
// preview) has a base URL on its own host. The serving line named that host, so such an instance's welcome
// read "served via <its own host>" and a preview's read "served via a preview environment",
// when the adapter forwards every request unchanged to its upstream. The line has to name where the
// answer is computed, never the app that relayed it (CUR-3573). A Mistral lane that reaches its model through a
// staging router must not print that router's hostname the same way, so no aipotluck.org host may appear at all.
const OWN_HOST =
	/served via (?:a preview environment|[\w.-]*aipotluck\.org|[\w-]+\.vercel\.app)|folkways-adapter/i;

test('neither the welcome nor the deployment’s serving line names this instance’s own host (CUR-3573)', async ({
	page
}) => {
	const res = await page.goto('/chat', { waitUntil: 'domcontentloaded' });
	expect(res?.status(), '/chat did not load').toBe(200);

	const body = page.locator('body');
	// The welcome names no host before a turn (CUR-2364), so it is read only for a leak; the shell
	// data below still carries the deployment's serving line, which the footprint panel reads.
	// With Auto on and left on Auto, it names no model either: Auto picks one per message.
	await expect(body, 'the empty state carried no serving line').toContainText(
		/Running on \S+|Alpha picks a model for each message/,
		{ timeout: 30_000 }
	);
	const welcome = (await body.innerText()) ?? '';
	const leak = welcome.match(OWN_HOST)?.[0];
	expect(
		leak,
		`the welcome names the instance relaying the request, not where it is served: "${leak}"`
	).toBeUndefined();

	const data = await page.request.get('/chat/__data.json');
	expect(data.status(), 'the chat shell data did not load').toBe(200);
	const firstChunk = (await data.text()).split('\n')[0];
	expect(firstChunk, 'the shell data carries no serving line, so this check read nothing').toMatch(
		/served (?:directly )?(?:via|by)/i
	);
	const tailLeak = firstChunk.match(OWN_HOST)?.[0];
	expect(
		tailLeak,
		`the deployment's serving line names the relaying instance: "${tailLeak}"`
	).toBeUndefined();

	// The staging router hands every Mistral model to La Plateforme, and the line said "served
	// via a staging router, hosted on public compute" over a Mistral answer computed in France (SOL-288).
	if (/"mistral-(?:medium|large)-\d+"/.test(firstChunk)) {
		expect(firstChunk, 'a Mistral default does not name Mistral in France').toContain(
			"Mistral AI's La Plateforme in France"
		);
		expect(firstChunk, 'a Mistral default still claims public compute').not.toMatch(
			/hosted on public compute/
		);
	} else {
		test.info().annotations.push({
			type: 'SOL-288',
			description: 'the default model here is not Mistral, so the Mistral serving line was not read'
		});
	}
});
