// e2e-product: @chat
// e2e-area: @agent
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { accountButton } from './helpers/accountMenu';
import { holdForRecording } from './helpers/recording';
import {
	agentGroup,
	agentOption,
	checkedAgentMode,
	openAgentTools,
	toolsButton,
	type AgentMode
} from './helpers/agentTool';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// A7 ("Alpha does the everyday jobs I need, and can run them for me").
//
// A7 had no journey at all. This file exists so that absence stops being invisible: the gallery
// reports A7 as `not-run` rather than leaving silence where a reader deciding what is ready would
// look. A board has to be able to tell "nothing was done" from "nothing was wired" (CUR-706); a
// journey missing from docs/journeys/ has exactly that defect, one level down.
//
// WHY THIS SIGNS IN (CUR-1644). An anonymous visitor skipping on `agentEnabled: false` would report
// agent mode as off on the deployment, which is not a fact about the deployment.
// `agentModeEnabledForUser` (`src/lib/chat/server/agentMode.ts`) denies a caller with no account
// outright, so that skip would fire on every deployment, even one with agent mode fully armed. A
// diagnostic that is true as written but cannot separate the two states its reader is choosing
// between is the defect to avoid.
//
// THE THIRD GATE. Signing in removes the account gate, and forcing `agent-mode` through the override
// cookie removes the deployment-level one. `agent-mode-access` is read per account through
// `flagEnabledForUser`, which calls PostHog directly and never consults the override cookie. Since
// CUR-1611 it has a release condition for `@example.org` accounts on preview only, which is the
// domain this suite mints, so the control is expected and its absence fails the spec.
//
// WHAT THIS COVERS: steps 1 through 3 of the journey doc — the control is
// discoverable, its label names both the current mode and what the mode does, and one tap advances
// it by one step with the label following. Steps 4 through 6 (the turn runs as work, it can be
// stopped, the account is auditable) have no assertions here on purpose. Writing them against a
// surface nobody can currently reach would make this spec's first real run the first test of its
// own selectors, which is the shape CUR-1335 is about — a wiring mistake there reads exactly like
// the failure the check is named for.

// @preview-only: reaches the agent control by forcing flags through the fuzz override cookie, which
// production deliberately does not wire. Scoped at the runner rather than skipped in the body — see
// sign-in.spec.ts's note on why a skip is the wrong shape for an environment fact.
test(
	'the agent control names its current mode and what turning it on does, and one tap advances it',
	{ tag: ['@preview-only', '@A7'] },
	async ({ page, context, baseURL }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true
		});
		await signInAsFreshUser(page);

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

		// The account gate is now satisfied, so the assertion below reads the flag rather than the persona.
		// Asserted rather than assumed: if sign-in silently did not take, that assertion would be about a
		// missing account again, which is the one failure this whole change exists to remove.
		//
		// The account button's accessible name is "Account — signed in as {name}" once sign-in took.
		await expect(
			accountButton(page),
			'sign-in did not take, so the agent-control check below would be about a missing account again rather than about the flag — the exact CUR-1644 defect this spec was rewritten to remove'
		).toHaveAccessibleName(/signed in as /i, { timeout: 30_000 });

		// Asserted, not skipped (CUR-1611). `agent-mode-access` carries a release condition, email ending
		// `@example.org` AND `env` = preview, so the minted account this suite signs in with is granted on
		// every preview and on no production deployment. A skip here would turn a lost condition into
		// silence; a failure names it.
		await journeyStep(page, 'A7', 1, async () => {
			await expect(
				toolsButton(page),
				"signed in as a minted @example.org account with `agent-mode` forced on, and the composer's Tools do not include the agent. The remaining gate is `agent-mode-access`, whose preview condition for @example.org accounts (CUR-1611) is what grants this suite; check that condition in PostHog before suspecting the product"
			).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });
		});

		// Step 1. Discoverable from the composer: the Tools button names the agent (asserted above).

		// Step 2. The control says which mode it is in, and what the modes do. A bare "Agent" would force
		// the user to turn it on to find out what it means, which is the failure the journey doc names.
		const modeBefore = await journeyStep(page, 'A7', 2, async () => {
			await openAgentTools(page, { timeout: 15_000 });
			const modeBefore = await checkedAgentMode(page);
			expect(
				modeBefore,
				`the Agent group should mark its current mode. Read: ${modeBefore}`
			).toMatch(/^(Off|Auto|On)$/);
			const described = (await agentGroup(page).innerText()).toLowerCase();
			expect(
				described,
				`the agent modes should say what turning it on does, so a user can decide without trying it. Read: ${described}`
			).toMatch(/multi-step|runs as an agent/);
			return modeBefore;
		});

		// Step 3. One tap, one step: choosing the next mode makes it the chosen one. The next mode is
		// derived from the observed one, since hardcoding "Auto" would only pass from a fresh default.
		// Each side of the tap is held for the recording: without a before and an after on screen, the
		// grader cannot tell a tap that moved the mode from one that did nothing (CUR-2337).
		const NEXT: Record<string, AgentMode> = { Off: 'Auto', Auto: 'On', On: 'Off' };
		// The Tools menu scrolls, and the Agent group sits below Web search, so the held "before" frame
		// showed Web search's choice with Agent's cropped out, and the click then scrolled the panel
		// itself, which the grader read as a jump rather than a tap. Scrolled into view first, the
		// before and after differ only in which Agent row is chosen (CUR-2337).
		await journeyStep(page, 'A7', 3, async () => {
			await agentGroup(page).scrollIntoViewIfNeeded();
			await holdForRecording(page);
			await agentOption(page, NEXT[modeBefore]).click();
			await expect(
				agentOption(page, NEXT[modeBefore]),
				`choosing "${NEXT[modeBefore]}" from "${modeBefore}" should make it the chosen mode`
			).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
			await holdForRecording(page);
		});

		// A second visit to row 3, so its first snapshot is the menu with the new mode chosen and this one
		// is the composer after the menu closes.
		await journeyStep(page, 'A7', 3, async () => {
			// The composer after the tap: the mode reads on the + menu's Agent row, and closing the menu
			// leaves no Agent chip beside the composer at any mode. Every earlier recording ended with the
			// menu still open, so no frame ever showed the composer after the tap.
			await page.keyboard.press('Escape');
			await expect(agentGroup(page), 'Escape should close the Tools menu').toBeHidden();
			await expect(
				page.locator('[data-composer-chip]', { hasText: 'Agent' }),
				`agent mode is now "${NEXT[modeBefore]}", and the composer should show no Agent chip for it`
			).toHaveCount(0);
			await holdForRecording(page);
		});
	}
);
