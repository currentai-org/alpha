// e2e-product: @chat
// e2e-area: @models
import { test, expect, type BrowserContext, type Page } from './helpers/test';
import { chatEntry, answerShapeEntry, LARGE4_MODEL } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { warmupContext } from './helpers/warmup';
import { turnDone } from './helpers/turn';
import { openAnswerSources } from './helpers/xray';
import { pinnedChatEntry } from './helpers/servedModel';
import { installFaultInjectionHeader } from './helpers/faultInjection';
import { openComposerTool, toolGroup } from './helpers/composerMenu';
import { startChattingPastWelcome } from './helpers/welcome';

// Two ways a person hands Alpha something to read — a long paste and a link — and the sidebar that
// covered the sign-in form.
//
// The CUR-1898 half of that report (a remote image in an answer loading unasked) has no browser test
// here: user messages don't pass through the markdown renderer, so only a model steered into writing
// an image could exercise it, and that isn't something a spec can arrange on demand. marked.spec.ts
// pins the renderer contract instead.

// Each link test has a twin, once on the default turn and once pinned to Large 4, whose turn is
// native, since every model is meant to read a pasted link the same way.
const LARGE_4 = LARGE4_MODEL;
type Fixtures = { page: Page; context: BrowserContext; baseURL: string | undefined };

async function openChat(page: Page, entry: string = answerShapeEntry()): Promise<void> {
	const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
	await page.addLocatorHandler(welcomeDialog, async () => {
		await startChattingPastWelcome(welcomeDialog);
	});
	await page.goto(entry, { waitUntil: 'commit' });
	await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });
}

async function finishedAnswer(page: Page, why: string) {
	await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
	const answer = page.locator('[data-message-role="assistant"]').last();
	// Retry, not the copy button, which can show before the turn ends (CUR-2133).
	await expect(turnDone(answer), why + warmupContext()).toBeVisible({
		timeout: 60_000
	});
	return answer;
}

// A paste of 3,984+ characters becomes a "Pasted Content" chip, and the attachments gate
// counted it as an attachment, so with `multimodal` off — production's state for every visitor —
// every send after one was refused and the message vanished. Preview has `multimodal` on for
// everyone, which is why no run here ever saw it: this test forces it off to stand where production
// stands. The answer has to use the pasted text, so a turn that merely arrived isn't enough.
test(
	'a long paste is read as text with attachments off: the answer uses what was pasted',
	{ tag: '@CUR-1895' },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		await openChat(page);

		const filler = 'This paragraph is office filler about the quarterly supply order. '.repeat(70);
		const memo = `${filler}\nThe meeting room door code is 4417.\n${filler}`;
		expect(memo.length).toBeGreaterThan(4000);

		await page.getByLabel('Message AI Potluck').evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, memo);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the path it is named for'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill(
			'What is the meeting room door code in the text I pasted? Answer with the number.'
		);
		await composer.press('Enter');

		const answer = await finishedAnswer(
			page,
			'no finished answer after a long paste: with the old gate the send is refused with a 415 and nothing is ever answered'
		);
		await expect(answer, 'the answer did not use the pasted text').toContainText('4417');
	}
);

// A paste of a Jane Austen excerpt of 100,008 characters got
// "flagged by a child-safety classifier". The input screen ran 9 chunks × 14 rules past its 20s
// deadline, the unanswered queries read as UNKNOWN, and child safety fails closed on UNKNOWN, so the
// decline named a classifier that had returned no verdict. A long paste of ordinary prose has to come
// back as an answer, or at worst as a plain "couldn't check this", never as a child-safety flag.
const PRIDE_AND_PREJUDICE = [
	'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
	'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.',
	'"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"',
	'Mr. Bennet replied that he had not.',
	'"But it is," returned she; "for Mrs. Long has just been here, and she told me all about it."',
	'Mr. Bennet made no answer.',
	'"Do you not want to know who has taken it?" cried his wife impatiently.',
	'"You want to tell me, and I have no objection to hearing it."',
	'This was invitation enough.'
].join('\n\n');

test(
	'a 100,000-character paste of ordinary prose is answered or told it could not be checked, never flagged for child safety',
	{ tag: ['@CUR-2301', '@real-screen'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		await openChat(page);

		const story = PRIDE_AND_PREJUDICE.repeat(Math.ceil(100_000 / PRIDE_AND_PREJUDICE.length)).slice(
			0,
			100_000
		);
		expect(story.length).toBe(100_000);

		await page.getByLabel('Message AI Potluck').evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, story);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the path it is named for'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Summarize this story in two sentences.');
		await composer.press('Enter');

		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			turnDone(answer),
			'no finished reply to a 100k-character paste' + warmupContext()
		).toBeVisible({
			timeout: 180_000
		});
		const text = await answer.innerText();
		expect(
			text,
			'a paste of Jane Austen was declined as a child-safety flag: the screen ran out of time and the decline named a classifier that returned no verdict'
		).not.toMatch(/child-safety classifier/i);
		// Either the model answered from the paste, or the screen said plainly that it couldn't check.
		const couldntCheck = /couldn['’]t finish the safety check/i.test(text);
		if (!couldntCheck) {
			expect(
				text,
				'the reply neither answers from the paste nor says the check could not run'
			).toMatch(/Bennet|Netherfield|fortune|wife/i);
		}
		test.info().annotations.push({
			type: 'CUR-2301 outcome',
			description: couldntCheck ? "couldn't-check notice" : 'answered from the paste'
		});
	}
);

// When the guard is slow, a long paste runs the input screen past its deadline, and the
// content rules queued last never get asked. Allowing the turn then let anyone skip those rules by
// padding a paste. `input_screen_unfinished` ends the real screen once every child-safety query has
// answered, which leaves content queries unasked the same way, so the turn has to come back as the
// couldn't-check notice and never as an answer.
test(
	'a long paste whose content rules the screen never got to is declined as could-not-check, not answered',
	{ tag: ['@CUR-3531', '@real-screen', '@preview-only'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		await installFaultInjectionHeader(page, 'input_screen_unfinished');
		await openChat(page);

		const story = PRIDE_AND_PREJUDICE.repeat(Math.ceil(30_000 / PRIDE_AND_PREJUDICE.length)).slice(
			0,
			30_000
		);
		await page.getByLabel('Message AI Potluck').evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, story);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the path it is named for'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Summarize this story in two sentences.');
		const sent = page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/conversation\/[a-f0-9]+$/.test(new URL(res.url()).pathname),
			{ timeout: 60_000 }
		);
		await composer.press('Enter');
		await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		expect(
			(await sent).headers()['x-fault-injected'],
			'the server did not apply input_screen_unfinished, so the screen ran to the end and this turn tests nothing'
		).toBe('input_screen_unfinished');

		const answer = page.locator('[data-message-role="assistant"]').last();
		await expect(
			answer,
			'the paste was answered although its content rules were never asked' + warmupContext()
		).toContainText(/couldn['’]t finish the safety check/i, { timeout: 120_000 });
		await expect(answer).not.toContainText(/child-safety classifier/i);
		await expect(answer).not.toContainText(/Bennet|Netherfield/);
	}
);

// A follow-up losing what came before: "translate it into French"
// after a paste answered that no text was included. The test above asks in the same turn as the
// paste; this one asks in the NEXT turn, so the pasted text has to survive as history. The first
// turn names nothing about the code, so only the pasted chip can supply the number.
test(
	'a follow-up in the next turn still reads a long paste from the turn before',
	{ tag: '@CUR-2077' },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { multimodal: false });
		await openChat(page);

		const filler = 'This paragraph is office filler about the quarterly supply order. '.repeat(70);
		const memo = `${filler}\nThe meeting room door code is 4417.\n${filler}`;
		expect(memo.length).toBeGreaterThan(4000);

		await page.getByLabel('Message AI Potluck').evaluate((el, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			el.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, memo);
		await expect(
			page.getByText('Pasted Content').first(),
			'the long paste did not turn into a chip, so this test is not exercising the path it is named for'
		).toBeVisible({ timeout: 10_000 });

		const composer = page.getByLabel('Message AI Potluck');
		await composer.fill('Here is a memo from the office. Reply with just "Got it."');
		await composer.press('Enter');
		await finishedAnswer(page, 'no finished answer to the turn that carried the paste');

		const answers = page.locator('[data-message-role="assistant"]');
		const before = await answers.count();
		await composer.fill(
			'What is the meeting room door code in the memo I pasted? Answer with the number.'
		);
		await composer.press('Enter');
		await expect(answers, 'the follow-up never got an answer of its own').toHaveCount(before + 1, {
			timeout: 30_000
		});
		const followUp = answers.last();
		await expect(
			followUp.getByRole('button', { name: 'Copy to clipboard', exact: true }),
			'the follow-up never finished' + warmupContext()
		).toBeVisible({
			timeout: 60_000
		});
		await expect(
			followUp,
			'the follow-up did not use the text pasted one turn earlier, so history lost the paste'
		).toContainText('4417');
	}
);

// A link pasted with "summarise this" used to go to search as part of a sentence, so the
// model saw only a search snippet (title, byline, first paragraph) and answered that it couldn't
// access links. Citing the page proves it was fetched; the answer has to use text past the opening
// to prove it was read. So this asks who the page quotes: Octavia Field Reid is named near the end of
// the Ada Lovelace Institute's release, far outside any snippet, and the model can't know her from
// the URL. Our own pages won't do here: the model knows them from community sources and can summarise
// one without reading it. This is the same page CUR-2032's test below depends on. Web search defaults
// to off, and a link is read only when it isn't off, so this sets auto the way a person would leave it.
//
// If this goes red on the Field Reid assertion, open the page first: it is a third-party page, and a
// move, a redirect, or a rewrite that drops her quote fails this exactly the way an unread page does.
async function linkedPageIsRead({ page }: Fixtures, native: boolean): Promise<void> {
	await page.addInitScript(() => {
		try {
			localStorage.setItem('ap:webSearchMode', 'auto');
		} catch {
			// Storage blocked: the control stays off and the source assertion below says so.
		}
	});
	await openChat(page, native ? pinnedChatEntry(LARGE_4) : chatEntry());

	const linked = 'https://www.adalovelaceinstitute.org/press-release/ada-turing-survey-2025/';
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(
		`Summarise this page in three sentences, and say who from the Ada Lovelace Institute it quotes: ${linked}`
	);
	await composer.press('Enter');

	const answer = await finishedAnswer(page, 'no finished answer to a summarise-this-link request');
	// The sources live in XRAY's step-by-step view, collapsed behind each step's "See N sources"
	// (helpers/xray.ts). The panel animates in, so a click can land on something still moving; retry
	// the whole open-and-expand until the source link is there.
	const linkedSource = page.getByRole('link', { name: /^Linked page:/ });
	await expect(async () => {
		if (!(await linkedSource.isVisible()))
			await openAnswerSources(page, answer, {
				disclosure: { timeout: 2_000 },
				tab: { timeout: 2_000 },
				sources: { timeout: 2_000 }
			});
		await expect(linkedSource).toBeVisible({ timeout: 1_000 });
	}, 'the answer carries no "Linked page" source, so the page was never read').toPass({
		timeout: 30_000
	});
	await expect(linkedSource).toHaveAttribute('href', linked);
	const text = await answer.innerText();
	expect(
		text,
		'the answer does not name the person the page quotes near its end, so it did not use the page past its opening'
	).toMatch(/Field Reid/i);
	expect(text, 'the answer claims it cannot open the link it was just given').not.toMatch(
		/(can(no|['’])t|unable to|not able to) (access|open|read|browse)/i
	);
}
test(
	'a linked page is read and cited as the first source, the answer uses text past its opening, and it does not claim it cannot open links',
	{ tag: '@CUR-1897' },
	async ({ page, context, baseURL }) => linkedPageIsRead({ page, context, baseURL }, false)
);
test(
	'a linked page is read and cited as the first source, the answer uses text past its opening, and it does not claim it cannot open links (native harness)',
	{ tag: ['@CUR-1897', '@CUR-2734'] },
	async ({ page, context, baseURL }) => linkedPageIsRead({ page, context, baseURL }, true)
);

// A link sent with search off got "I don't have access to external links", and after search was
// switched on, the same request came back "paste the text here" with the page already fetched and
// grounded as source [1]. The first reply anchored the second. So this runs both turns in one
// conversation: the search-off reply has to say why the page wasn't opened rather than claim links
// can't be opened, and the search-on reply has to answer from the page despite what came before.
// It uses a page the model does not already know from community sources: for our own pages the
// search-off turn is answered from those, no refusal forms, and the test would pass against the
// unfixed build. 3,513 is the survey's sample size, stated on that page and nowhere a model would
// find it without reading it.
async function linkReadOnSecondSend({ page }: Fixtures, native: boolean): Promise<void> {
	await page.addInitScript(() => {
		try {
			// Only on the first load: the test switches the control itself for the second turn.
			if (!sessionStorage.getItem('cur2032-seeded')) {
				// Both keys: since CUR-2030 an "off" under the old key alone reads as the old default
				// and starts on auto, and the choice key is what records someone picking off.
				localStorage.setItem('ap:webSearchChoice', 'off');
				localStorage.setItem('ap:webSearchMode', 'off');
				sessionStorage.setItem('cur2032-seeded', '1');
			}
		} catch {
			// Storage blocked: the control check below says which mode the test is actually in.
		}
	});
	await openChat(page, native ? pinnedChatEntry(LARGE_4) : chatEntry());
	// Web search's mode is a radio group in the composer's + menu, in its Web search flyout.
	const searchMode = (mode: 'Off' | 'Auto') =>
		toolGroup(page, 'Web search').getByRole('menuitemradio', { name: new RegExp(`^${mode}\\b`) });
	const openTools = () => openComposerTool(page, 'Web search', { timeout: 15_000 });
	await openTools();
	await expect(searchMode('Off'), 'the search control did not start off').toHaveAttribute(
		'aria-checked',
		'true'
	);
	await page.keyboard.press('Escape');

	const linked = 'https://www.adalovelaceinstitute.org/press-release/ada-turing-survey-2025/';
	const request = `Can you summarise the survey on this page, including how many people took part? ${linked}`;
	const cannotOpen =
		/(can(no|['’])t|unable to|not able to|don['’]t have (the )?(ability|access)) (to )?(access|open|read|browse|retrieve)/i;
	const composer = page.getByLabel('Message AI Potluck');
	await composer.fill(request);
	await composer.press('Enter');

	const first = await finishedAnswer(page, 'no finished answer to the search-off link request');
	const firstText = await first.innerText();
	// The contract is scope: "I can't open this now, because of this turn's setting" is the reply
	// wanted, and "I can never browse" is the defect. Words alone do not separate them, since correct
	// replies say "browse the web", "access to external" and "from external URLs" too. So a browse
	// claim fails only when the reply ties it to nothing about this turn. A correct reply scoped with
	// other words ("right now", "at the moment") would still go red; widen `turnScope` if one does.
	//
	// Test cases, all real replies. Re-run them after changing either pattern:
	// pass  "I don't have access to external web pages — web search is turned off for this turn.
	//       You can turn it on by selecting "auto" next to the message box, …"
	// pass  "Web search is off for this turn; the link was not opened. … I cannot retrieve or
	//       summarise content from external URLs when web search is disabled."
	// pass  "I cannot open links or browse the web in this turn. Turn on the "Web search" control
	//       beside the message box to auto-search, …"
	// fail  "I don't have access to live web pages or the ability to browse the internet" (the
	//       unfixed build)
	expect(firstText, 'with search off, the answer should say search is off').toMatch(/search/i);
	const browseClaim = /ability to browse|browse the (web|internet)/i;
	const turnScope = /\b(this|the current) turn\b|\b(is|are|turned|switched) off\b|\bdisabled\b/i;
	expect(
		browseClaim.test(firstText) && !turnScope.test(firstText),
		`with search off, the answer claims it can never browse, rather than naming this turn's setting: ${firstText}`
	).toBe(false);

	await openTools();
	await searchMode('Auto').click();
	await expect(
		searchMode('Auto'),
		'choosing Auto should move the control from off to auto'
	).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await composer.fill(request);
	await composer.press('Enter');

	const answers = page.locator('[data-message-role="assistant"]');
	await expect(answers, 'the second turn never produced an answer').toHaveCount(2, {
		timeout: 60_000
	});
	const second = await finishedAnswer(page, 'no finished answer to the search-on link request');
	const linkedSource = page.getByRole('link', { name: /^Linked page:/ });
	await expect(async () => {
		if (!(await linkedSource.isVisible()))
			await openAnswerSources(page, second, {
				disclosure: { timeout: 2_000 },
				tab: { timeout: 2_000 },
				sources: { timeout: 2_000 }
			});
		await expect(linkedSource).toBeVisible({ timeout: 1_000 });
	}, 'the second answer carries no "Linked page" source, so the page was never read').toPass({
		timeout: 30_000
	});
	const secondText = await second.innerText();
	expect(secondText, 'the answer does not carry the sample size the linked page states').toMatch(
		/3,?513/
	);
	expect(
		secondText,
		'the page was read, and the answer still asks for the text to be pasted'
	).not.toMatch(/\bpaste\b/i);
	expect(
		secondText,
		'the page was read, and the answer still claims it cannot open links'
	).not.toMatch(cannotOpen);
}
test(
	'a link sent with search off, then again with search on, is read the second time despite the first reply',
	{ tag: '@CUR-2032' },
	async ({ page, context, baseURL }) => linkReadOnSecondSend({ page, context, baseURL }, false)
);
test(
	'a link sent with search off, then again with search on, is read the second time despite the first reply (native harness)',
	{ tag: ['@CUR-2032', '@CUR-2734'] },
	async ({ page, context, baseURL }) => linkReadOnSecondSend({ page, context, baseURL }, true)
);

// On the old floating rail, the expanded sidebar stayed open after "Log in" was clicked from
// it and covered the email field at narrow desktop widths. The design system's sidebar sits beside the
// page instead, but the promise is the same: after "Log in", the email field is on screen, uncovered,
// and takes an unforced click. 900px is inside the band where the old rail overlapped.
//
// This starts on a model's own page, not chatEntry(). The entry resolves to the CMS-rendered
// /alpha/chat (bare /chat redirects there too), and leaving it for /chat/login remounts the whole
// shell with the rail closed, so the defect never shows — run from there, this test passed against
// the unfixed build. A user clicking from inside a conversation shares the /chat layout with the
// login page, so the shell stays mounted; /chat/models/<id> is in that layout and needs no billed turn
// to reach.
test.describe('at a 900px-wide desktop window', () => {
	test.use({ viewport: { width: 900, height: 800 } });

	test(
		'signing in from the sidebar leaves the email field usable at a narrow desktop width',
		{ tag: '@CUR-1899' },
		async ({ page }) => {
			const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
			await page.addLocatorHandler(welcomeDialog, async () => {
				await startChattingPastWelcome(welcomeDialog);
			});
			await page.goto(`/chat/models/${LARGE_4}`, { waitUntil: 'commit' });
			// A model's page opens on the welcome dialog. Clicking the composer waits for hydration and lets
			// the handler above close it now, not part-way through the sign-in below.
			await page.getByLabel('Message AI Potluck').click({ timeout: 30_000 });

			// "Log in" lives in the account menu at the foot of the sidebar. The sidebar is persistent and
			// sits beside the page rather than over it, so the claim to prove is the one a person feels: the
			// email field is on screen, nothing covers it, and it takes a click.
			const accountMenu = page.locator('[data-account-trigger]:visible').first();
			const logIn = page.getByRole('menuitem', { name: 'Log in' });
			// A click that lands before hydration does nothing, so retry until the menu opens.
			await expect(async () => {
				if (!(await logIn.isVisible())) await accountMenu.click({ timeout: 2_000 });
				await expect(logIn).toBeVisible({ timeout: 1_000 });
			}, 'the account menu never opened, so this test is not exercising the path it is named for').toPass(
				{
					timeout: 20_000
				}
			);
			await logIn.click();
			await page.waitForURL(/\/chat\/login/, { timeout: 15_000 });

			const email = page.locator('#signin-email');
			await expect(email, 'the email field is off screen at a narrow desktop width').toBeInViewport(
				{
					timeout: 5_000
				}
			);
			await expect
				.poll(
					() =>
						email.evaluate((el) => {
							const r = el.getBoundingClientRect();
							const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
							return hit === el || el.contains(hit);
						}),
					{
						message: 'something covers the email field after navigating to sign-in',
						timeout: 5_000
					}
				)
				.toBe(true);
			await email.click({ timeout: 5_000 });
			await expect(page.locator('#signin-email')).toBeFocused();
		}
	);
});
