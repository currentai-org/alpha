// e2e-product: @chat
// e2e-area: @agent
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { turnDone } from './helpers/turn';
import { agentOption, openAgentTools, toolsButton } from './helpers/agentTool';
import { journeyStep } from './helpers/journeyStep';
import { startChattingPastWelcome } from './helpers/welcome';

// A7, the round trip CUR-546 exists for: the agent writes a file, and the person takes it away.
//
// Before this spec nothing downloaded an agent's file end to end. The route
// (`chat/conversation/[id]/agent-artifact/[...filename]/+server.ts`) had unit coverage for its path
// guard, and the renderer (`renderArtifacts` in endpointAgent.ts) had unit coverage for its links, but
// the two meet only through agent-service's live session workdir, which no unit test reaches.
//
// The file's contents carry a nonce minted here, so a pass cannot come from the model inventing a
// plausible answer or from a cached file: the bytes that arrive through the download must be the ones
// this run asked the agent to write.
//
// Reachable by a signed-in `@example.org` account on preview because `agent-mode-access` grants that
// domain there (CUR-1611). `agent-mode` and `agent-artifact-download` are forced through the override
// cookie; both are already 100% on preview, so the cookie pins them rather than turning them on.

// @preview-only for the same reason as everyday-jobs.spec.ts: the override cookie is not wired on
// production, and agent mode is off there.
test(
	'a file the agent writes can be downloaded from the turn, and the bytes are the ones it was asked for',
	{ tag: ['@preview-only', '@A7', '@CUR-546', '@CUR-4398'] },
	async ({ page, context, baseURL }) => {
		// An agent turn runs a sandbox and several model rounds; three minutes is the observed ceiling
		// on develop with room to spare, not a padded guess at an unknown.
		test.setTimeout(300_000);

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await setFlagOverrides(context, baseURL!, {
			'agent-mode': true,
			'agent-artifact-download': true
		});
		await signInAsFreshUser(page);

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });

		await journeyStep(page, 'A7', 1, async () => {
			await expect(
				toolsButton(page),
				'the agent control is not offered for a minted @example.org account. `agent-mode-access` grants that domain on preview (CUR-1611); check that condition before suspecting the download path'
			).toHaveAccessibleName(/\bagent\b/i, { timeout: 30_000 });
		});

		// "On", not "Auto": auto would let the router decide this turn is plain chat, and then there is
		// no file to download and the spec measures the router. Not marked as A7 row 3: the row is one
		// tap advancing one step, which everyday-jobs walks, and this jumps straight to On.
		await openAgentTools(page, { timeout: 15_000 });
		await agentOption(page, 'On').click();
		await expect(
			agentOption(page, 'On'),
			'the Agent group never marked "On" as chosen'
		).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
		await page.keyboard.press('Escape');

		const nonce = randomBytes(6).toString('hex');
		const filename = `receipt-${nonce}.txt`;
		const answer = page.locator('[data-message-role="assistant"]').last();
		await journeyStep(page, 'A7', 4, async () => {
			await composer.fill(
				`Create a text file named ${filename} whose only content is the line: potluck ${nonce}`
			);
			await composer.press('Enter');

			// The develop agent asks before it writes: each edit, terminal or execute_code call raises a
			// "This turn wants to" card that times out to Deny. A person would approve a file they asked
			// for, so the spec does too, one card at a time, until the turn ends. Without this every write
			// is denied and the turn ends with nothing to download.
			const allow = page.getByRole('button', { name: 'Allow', exact: true }).first();
			await expect
				.poll(
					async () => {
						if (await allow.isVisible()) await allow.click();
						return turnDone(answer).isVisible();
					},
					{ message: 'the agent turn did not finish', timeout: 240_000, intervals: [1_000] }
				)
				.toBe(true);
			await expect(
				answer.getByText(/took too long to respond/),
				'the turn ended in a timeout rather than an answer'
			).toHaveCount(0);
			// The answer repeats the summary its reasoning ended with, and the loop cut read that
			// as a loop, so a correct answer with a file ended in this notice.
			await expect(
				answer.getByText(/stuck repeating myself/),
				'the answer restating its own summary was cut as a loop'
			).toHaveCount(0);

			// The turn shows it ran as work: a progress block whose header says the output was computed,
			// holding the step count endpointAgent.ts writes from the final usage frame. Without it the
			// turn looks like an ordinary answer, which is A7 step 4's failure. Unanchored: the button's
			// text content carries the whitespace around the label, so ^…$ never matches.
			const work = answer.getByRole('button', { name: /expand|collapse/i }).filter({
				hasText: /\b(Working|Predicted|Did not finish)\b/
			});
			await expect(
				work,
				'the finished agent turn has no progress block, so it reads as a plain answer'
			).toBeVisible();
			if ((await work.getAttribute('aria-label')) === 'Expand') await work.click();
			await expect(
				answer.getByText(/Ran \d+ step\(s\)/),
				'the progress block does not say how many steps the run took'
			).toBeVisible({ timeout: 10_000 });
		});

		const link = await journeyStep(page, 'A7', 6, async () => {
			// The section renderArtifacts appends, and its retention line. Since CUR-4398 the turn saves the
			// file with the conversation, so the line promises no window, and the reply carries the saved
			// copy as a file of its own.
			await expect(
				answer.getByText('Files this turn produced'),
				'the turn finished without listing any file, so the agent did not write one or the artifact section was dropped'
			).toBeVisible();
			await expect(
				answer.getByText('Saved with this conversation, so you can download them any time.'),
				'files are listed without the saved line: either `agent-artifact-download` read as off when the turn rendered, or the file was not saved and only the live workdir holds it'
			).toBeVisible();
			await expect(
				answer.locator('[data-attachment-row]').getByRole('button', { name: `Open ${filename}` }),
				`the reply carries no saved copy of ${filename}, so the file lives only in the agent's workdir`
			).toBeVisible();

			const link = answer.getByRole('link', { name: filename });
			await expect(
				link,
				`no download link named ${filename}; the agent may have written the file under another name`
			).toBeVisible();
			return link;
		});

		const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
		expect(download.suggestedFilename()).toBe(filename);
		const path = await download.path();
		const body = await readFile(path, 'utf8');
		expect(
			body.trim(),
			'the downloaded bytes are not the line this run asked for, so the route served a different file or the agent wrote something else'
		).toBe(`potluck ${nonce}`);

		// The saved copy itself, read through the conversation's stored files rather than the agent's
		// workdir: opening the reply's file shows the bytes the turn kept.
		await answer
			.locator('[data-attachment-row]')
			.getByRole('button', { name: `Open ${filename}` })
			.click();
		await expect(
			page.getByRole('dialog').getByText(`potluck ${nonce}`),
			'the saved copy does not hold the line the agent wrote, so the turn stored something else or nothing'
		).toBeVisible({ timeout: 15_000 });
	}
);
