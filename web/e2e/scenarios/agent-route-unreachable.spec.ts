// e2e-product: @chat
// e2e-area: @agent
import { test, expect, type Page, type BrowserContext } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { installCannedReplies, installFaultInjectionHeader } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';

// With Agent on Auto, each turn first asks the agent service's /route classifier whether it
// needs the agent. When that check fails or times out, the selected model answers anyway, and before
// this change the answer looked exactly like one the classifier had judged ordinary: A7 row 4's
// "feels broken if". The two tests differ in one thing, the `agent_route_down` fault, so the note's
// presence in the first and absence in the second are both about the route check and nothing else.
//
// @preview-only: reaches the agent control by forcing `agent-mode` through the override cookie, and
// arms a fault, neither of which production wires. `agent-mode-access` grants the minted
// @example.org account on previews (CUR-1611).

const NOTE = 'The agent wasn’t reachable';

async function onAuto(page: Page, context: BrowserContext, baseURL: string) {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await setFlagOverrides(context, baseURL, { 'agent-mode': true });
	await signInAsFreshUser(page);
	await page.goto(chatEntry(), { waitUntil: 'commit' });
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await expect(
		toolsButton(page),
		'the agent control is not offered for a minted @example.org account (`agent-mode-access`, CUR-1611)'
	).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });
	await openAgentTools(page, { timeout: 15_000 });
	await agentOption(page, 'Auto').click();
	await expect(agentOption(page, 'Auto')).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	return composer;
}

// The failed-route half moved below e2e (SOL-195): server.turn.spec.ts drives the turn route with the
// check failing and reads the note streamed and stored; ChatMessage.svelte.test.ts renders it. This
// half stays, because only a real classifier answering proves the note isn't shown by default.
test(
	'on Auto, a route check that answers "direct" puts no agent-unreachable note on the answer',
	{ tag: ['@preview-only', '@A7', '@CUR-2830'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const composer = await onAuto(page, context, baseURL!);
		// The real classifier decides; the canned reply only spares a model answer nobody reads.
		await installCannedReplies(page);

		await composer.fill('What is the capital of Portugal?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
		await expect(
			answer.getByText(NOTE),
			'the classifier answered, yet the answer says the agent was unreachable. If the agent service is down on this preview, the first test above is the expected reading'
		).toHaveCount(0);
	}
);

// The agent service screens /route's prompt and answers 403 "blocked by moderation" when it
// refuses. That is a verdict from a service that was reached, yet the chat counted it as a failed
// check and put "The agent wasn't reachable" under the refusal. The fault answers /route exactly so.
test(
	'on Auto, a prompt the agent service screens out puts no agent-unreachable note on the answer',
	{ tag: ['@preview-only', '@A7', '@CUR-4056'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(180_000);
		const composer = await onAuto(page, context, baseURL!);
		await installFaultInjectionHeader(page, 'agent_route_screened');

		await composer.fill('What is the capital of Portugal?');
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 30_000 });

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(answer)).toBeVisible({ timeout: 120_000 });
		await expect(
			answer.getByText(NOTE),
			"the agent service answered /route with its input screen's refusal, and the answer still says it was unreachable"
		).toHaveCount(0);

		// A reload reads the stored answer, which must not carry the note either.
		await page.reload();
		const stored = page.locator('[data-message-role="assistant"]').last();
		await expect(turnDone(stored)).toBeVisible({ timeout: 30_000 });
		await expect(stored.getByText(NOTE)).toHaveCount(0);
	}
);
