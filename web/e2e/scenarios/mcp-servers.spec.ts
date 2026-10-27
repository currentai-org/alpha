// e2e-product: @chat
// e2e-area: @agent @settings
// A person asks Alpha to read a setting and change it, through an MCP server the operator
// configured, in one turn, confirming before the change runs. The server is the in-deployment stub that
// `mcp_stub_server` adds (web/src/lib/chat/server/mcp/e2eStub.ts): get_setting is marked read-only and
// runs unasked, set_setting is not and waits for Allow, get_admin_lock answers isError (CUR-2645).
//
// Entered on Large 4, which calls tools natively, so the model decides the calls and the kit's cap and
// confirmation are what is under test. Preview-only: production refuses both the fault and the override.
import { test, expect, type Page } from './helpers/test';
import { LARGE4_MODEL } from './helpers/chatEntry';
import { agentOption, openAgentTools } from './helpers/agentTool';
import { faultInjectionHeaders, installFaultInjectionHeader } from './helpers/faultInjection';
import { setFlagOverrides } from './helpers/flagOverride';
import { journeyStep } from './helpers/journeyStep';
import { composerHydrated } from './helpers/composer';
import { signInAsFreshUser } from './helpers/session';
import { pinnedChatEntry } from './helpers/servedModel';
import { turnDone } from './helpers/turn';
import { openStepByStep, openXrayTab } from './helpers/xray';
import { startChattingPastWelcome } from './helpers/welcome';

async function openComposer(page: Page): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'commit' });
	// An Enter pressed before hydration leaves the text in the box and sends nothing (the page then shows
	// "Model: Auto" and the prompt still in the composer).
	await composerHydrated(page);
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

async function send(page: Page, text: string): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(text);
	await composer.press('Enter');
}

/** The connectors page lists, probes and adds the stub only for a request carrying its fault, so the
 *  fault header rides the page's own requests (the document, SvelteKit's __data.json and the form
 *  actions) as well as the chat send. */
async function stubOnConnectorsPage(page: Page): Promise<void> {
	const stubHeaders = faultInjectionHeaders('mcp_stub_server');
	await page.route(
		(url) => /\/settings\/connectors(\/__data\.json)?$/.test(url.pathname),
		(route) => route.continue({ headers: { ...route.request().headers(), ...stubHeaders } })
	);
}

/** From the composer to Settings → Connectors, through the + menu (CUR-4016). */
async function openConnectors(page: Page): Promise<void> {
	const row = page.getByTestId('composer-connectors');
	await expect(async () => {
		if (!(await row.isVisible()))
			await page.getByRole('button', { name: /^Add files and tools/ }).click({ timeout: 2_000 });
		await row.click({ timeout: 2_000 });
		await expect(page).toHaveURL(/\/chat\/settings\/connectors/, { timeout: 5_000 });
	}, 'the + menu never led to Settings → Connectors').toPass({ timeout: 30_000 });
}

/** The X-ray "Step by step" text for the last answer. */
async function stepByStep(page: Page): Promise<string> {
	const reply = page.locator('[data-message-role="assistant"]').last();
	await openStepByStep(page, reply, { disclosure: { timeout: 30_000 }, tab: { timeout: 10_000 } });
	const steps = page.locator('[data-xray-steps]');
	await expect(steps.locator('[data-step-by-step]')).toBeVisible({ timeout: 10_000 });
	const text = await steps.innerText();
	await page.keyboard.press('Escape');
	return text;
}

// X-ray opens on "This answer"; its receipt is what a person reads first (CUR-4038).
async function thisAnswer(page: Page): Promise<string> {
	const reply = page.locator('[data-message-role="assistant"]').last();
	await openXrayTab(page, reply, 'This answer', {
		disclosure: { timeout: 30_000 },
		tab: { timeout: 10_000 }
	});
	const receipt = page.locator('[data-answer-receipt]');
	await expect(receipt).toBeVisible({ timeout: 10_000 });
	const text = await receipt.innerText();
	await page.keyboard.press('Escape');
	return text;
}

test(
	'a configured MCP server reads a setting and, once the person allows it, changes it in one turn',
	{ tag: ['@preview-only', '@CUR-3026'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'mcp-servers': true });
		await installFaultInjectionHeader(page, 'mcp_stub_server');
		await openComposer(page);

		// Worded unlike the other two tests in this file on purpose (CUR-4054). PR runs replay the base branch's
		// recordings by a loose key that drops tool ids and results, and the store keeps one recording per
		// key, the newest. With one shared prompt, the last test to record on the base branch decided turn one's
		// answer on every PR, and this test's turn two, which only this test sends, then had no recording
		// that matched and got a mock that calls no tool.
		await send(
			page,
			'With the stub tools, look up my accent_color setting and then set it to orange. What was it before, and what is it now?'
		);
		const reply = page.locator('[data-message-role="assistant"]').last();

		// The write waits for the person: the card names the tool, and nothing has finished yet.
		const card = reply.getByText(/This turn wants to: run set_setting on stub/);
		await expect(card, 'no confirmation card for the write tool').toBeVisible({ timeout: 90_000 });
		await expect(turnDone(reply), 'the turn finished before the person answered').toBeHidden();
		await reply.getByRole('button', { name: 'Allow' }).click();
		await expect(reply.getByText(/run set_setting on stub — Allowed\./)).toBeVisible({
			timeout: 15_000
		});

		await expect(turnDone(reply), 'the turn never finished after Allow').toBeVisible({
			timeout: 90_000
		});
		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
		// "teal" is the value only the read tool returns; "orange" is the one the write set.
		expect(answer, 'the answer does not carry the value the read tool returned').toMatch(/teal/i);
		expect(answer, 'the answer does not carry the new value').toMatch(/orange/i);

		const trace = await stepByStep(page);
		expect(trace, 'the trace does not show the read call').toContain('get_setting on stub');
		expect(trace, 'the trace does not show the confirmed write call').toContain(
			'set_setting on stub: it ran'
		);

		// CUR-2645 on the same server: a tool that answers isError is shown as an error, not a result.
		await send(
			page,
			'Now use the stub tool get_admin_lock to check whether my settings are locked.'
		);
		const second = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(second), 'the isError turn never finished').toBeVisible({
			timeout: 90_000
		});
		const errorTrace = await stepByStep(page);
		expect(errorTrace, 'the isError call is not shown as a tool error').toContain(
			'A tool reported an error'
		);
		const secondAnswer = (await second.locator('.prose').allInnerTexts()).join('\n');
		expect(
			secondAnswer,
			'the answer reports the failed lock check as a result instead of a failure'
		).toMatch(/unavailable|error|couldn.t|could not|failed|unable/i);
	}
);

// F1's journey (docs/journeys/f1-change-a-setting-through-a-tool.md): the same flow, signed in as a team
// account with no flag override, so the flag is PostHog's own team condition, as a team member reaches it.
test(
	'a team account asks Alpha to change a setting through the configured tool server and confirms it',
	{ tag: ['@F1', '@preview-only', '@CUR-3026'] },
	async ({ page }) => {
		test.setTimeout(180_000);
		await installFaultInjectionHeader(page, 'mcp_stub_server');
		await signInAsFreshUser(page);
		await openComposer(page);
		const reply = page.locator('[data-message-role="assistant"]').last();

		// A team account has agent mode on, and an agent turn does not reach the configured servers yet
		// (CUR-3025), so the person turns agent off in the Tools menu first (the journey doc's Known gaps).
		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'Off').click();
		await expect(agentOption(page, 'Off')).toHaveAttribute('aria-checked', 'true', {
			timeout: 10_000
		});
		await page.keyboard.press('Escape');

		await journeyStep(page, 'F1', 1, async () => {
			await send(
				page,
				'Use the stub tools: first read my accent_color setting, then change it to orange. Tell me the old and the new value.'
			);
			await expect(
				reply.getByText(/This turn wants to: run set_setting on stub/),
				'no confirmation card for the write tool'
			).toBeVisible({ timeout: 90_000 });
			await expect(turnDone(reply), 'the turn finished before the person answered').toBeHidden();
		});

		await journeyStep(page, 'F1', 2, async () => {
			await reply.getByRole('button', { name: 'Allow' }).click();
			await expect(reply.getByText(/run set_setting on stub — Allowed\./)).toBeVisible({
				timeout: 15_000
			});
			await expect(turnDone(reply), 'the turn never finished after Allow').toBeVisible({
				timeout: 90_000
			});
			const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
			expect(answer, 'the answer does not carry the value the read tool returned').toMatch(/teal/i);
			expect(answer, 'the answer does not carry the new value').toMatch(/orange/i);
		});

		await journeyStep(page, 'F1', 3, async () => {
			const trace = await stepByStep(page);
			expect(trace, 'the trace does not show the read call').toContain('get_setting on stub');
			expect(trace, 'the trace does not show the confirmed write call').toContain(
				'set_setting on stub: it ran'
			);
		});
	}
);

test(
	'with mcp-servers off, the configured server is never offered and no confirmation appears',
	{ tag: ['@preview-only', '@CUR-3026'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'mcp-servers': false });
		await installFaultInjectionHeader(page, 'mcp_stub_server');
		await openComposer(page);

		await send(page, 'Use the stub tools to change my accent_color setting to orange.');
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply), 'the turn never finished').toBeVisible({ timeout: 90_000 });
		await expect(reply.getByText(/This turn wants to:/)).toHaveCount(0);
		const trace = await stepByStep(page);
		expect(trace, 'a stub tool ran with the flag off').not.toContain('on stub');
	}
);

// Settings → Connectors (CUR-3984). The person opens settings from the chat, finds the stub server and
// its tools there, sets the write tool to always allow, and the next turn changes the setting with no
// confirmation card. The connectors page lists the stub only for a request carrying its fault, so the
// fault header rides the page's own requests (the document and SvelteKit's __data.json) as well as the
// chat send.
test(
	'a tool set to always allow in Settings → Connectors runs on the next turn with no confirmation card',
	{ tag: ['@preview-only', '@CUR-3984'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'mcp-servers': true });
		await installFaultInjectionHeader(page, 'mcp_stub_server');
		await stubOnConnectorsPage(page);
		await openComposer(page);

		// Settings lives in the account menu at the foot of the sidebar (application-settings.spec.ts).
		await expect(async () => {
			const settingsItem = page.getByRole('menuitem', { name: 'Settings' });
			if (!(await settingsItem.isVisible())) {
				await page.locator('[data-account-trigger]:visible').first().click({ timeout: 3_000 });
			}
			await settingsItem.click({ timeout: 3_000 });
		}).toPass({ timeout: 20_000 });
		await page
			.getByRole('link', { name: /^Connectors/ })
			.first()
			.click({ timeout: 30_000 });
		await expect(page.getByRole('heading', { level: 1, name: 'Connectors' })).toBeVisible({
			timeout: 15_000
		});

		const writeTool = page.locator('[data-connector-tool="stub__set_setting"]');
		await expect(writeTool, 'the stub write tool is not listed under Connectors').toBeVisible({
			timeout: 15_000
		});
		await expect(writeTool.getByText('Changes something')).toBeVisible();
		await expect(
			page.locator('[data-connector-tool="stub__get_setting"]').getByText('Read-only')
		).toBeVisible();
		await expect(writeTool.getByRole('radio', { name: 'Ask first' })).toBeChecked();

		const saved = page.waitForResponse(
			(r) => r.request().method() === 'POST' && /\/chat\/settings$/.test(new URL(r.url()).pathname)
		);
		await writeTool.getByRole('radio', { name: 'Always allow' }).click();
		expect((await saved).ok(), 'saving the choice failed').toBe(true);
		await expect(page.locator('[data-connectors-status="saved"]')).toBeVisible({ timeout: 10_000 });
		await expect(writeTool.getByRole('radio', { name: 'Always allow' })).toBeChecked();

		await openComposer(page);
		// Its own wording, so its recording never stands in for another test's turn (CUR-4054).
		await send(
			page,
			'Using the stub tools, read my accent_color setting, then change it to orange, and tell me both values.'
		);
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply), 'the turn never finished').toBeVisible({ timeout: 90_000 });
		await expect(
			reply.getByText(/This turn wants to:/),
			'a confirmation card appeared for a tool set to always allow'
		).toHaveCount(0);
		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
		expect(answer, 'the answer does not carry the new value').toMatch(/orange/i);

		const trace = await stepByStep(page);
		expect(trace, 'the write tool did not run').toContain('set_setting on stub: it ran');
	}
);

// A signed-in person adds an MCP server of their own in Settings → Connectors, reached from
// the composer's + menu, uses its tool in chat, and removes it. The address is the in-deployment stub's,
// which answers only while `mcp_stub_server` is on; added by the person, it replaces the operator's stub
// entry, so the tool the turn calls can only have come from the person's own server.
test(
	'a person adds their own MCP server in Settings → Connectors, calls its tool in chat, and removes it',
	{ tag: ['@preview-only', '@CUR-4016', '@CUR-4038'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		await setFlagOverrides(context, baseURL!, { 'mcp-servers': true });
		await installFaultInjectionHeader(page, 'mcp_stub_server');
		await stubOnConnectorsPage(page);
		await signInAsFreshUser(page);
		await openComposer(page);

		// A team account has agent mode on, and an agent turn does not reach the servers (CUR-3025).
		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'Off').click();
		await expect(agentOption(page, 'Off')).toHaveAttribute('aria-checked', 'true', {
			timeout: 10_000
		});
		await page.keyboard.press('Escape');

		await openConnectors(page);

		const addForm = page.getByTestId('connector-add-form');
		await expect(addForm, 'no add form for a signed-in person').toBeVisible({ timeout: 30_000 });
		await addForm.getByLabel('Name').fill('mine');
		await addForm.getByLabel('Server URL').fill('https://mcp-stub.e2e.invalid/mcp');
		await addForm.getByLabel('Bearer token (optional)').fill('e2e-token-not-a-secret');
		await addForm.getByRole('button', { name: 'Add server' }).click();

		const mine = page.locator('[data-connector="mine"]');
		await expect(mine, 'the added server is not listed').toBeVisible({ timeout: 30_000 });
		await expect(mine.locator('[data-connector-status]')).toHaveText(/Connected · 3 tools/);
		await expect(mine.getByRole('button', { name: 'Remove mine' })).toBeVisible();
		await expect(
			page.locator('[data-connector="stub"]'),
			'the operator stub is still listed'
		).toHaveCount(0);
		// The token never comes back to the page.
		expect(await page.content()).not.toContain('e2e-token-not-a-secret');

		await openComposer(page);
		await send(page, 'Use the mine tools to read my accent_color setting and tell me its value.');
		const reply = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(reply), 'the turn never finished').toBeVisible({ timeout: 90_000 });
		const answer = (await reply.locator('.prose').allInnerTexts()).join('\n');
		expect(answer, 'the answer does not carry the value the read tool returned').toMatch(/teal/i);
		expect(
			await stepByStep(page),
			'the trace does not show the call to the person’s server'
		).toContain('get_setting on mine');
		expect(
			await thisAnswer(page),
			'X-ray’s "This answer" tab does not name the person’s server and tool'
		).toContain('get_setting on mine: it ran');

		await openConnectors(page);
		await expect(mine).toBeVisible({ timeout: 30_000 });
		await mine.getByRole('button', { name: 'Remove mine' }).click();
		await expect(mine, 'the removed server is still listed').toHaveCount(0, { timeout: 30_000 });
		await expect(page.locator('[data-connector="stub"]')).toBeVisible();
	}
);
