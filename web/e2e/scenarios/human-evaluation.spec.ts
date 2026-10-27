// e2e-product: @chat
// e2e-area: @models
import { test, expect, type Page } from './helpers/test';
import { signInAsFreshUser } from './helpers/session';
import { setFlagOverrides } from './helpers/flagOverride';
import { startChattingPastWelcome } from './helpers/welcome';

// The human evaluation API and the /chat/settings/evaluate page, both behind the
// `human-eval` flag (CUR-1913, CUR-1914). The first two tests pin the server contract the page calls; the last two drive
// the page itself, from the sidebar's Contribute link to a rating, against that same API. The full rating flow,
// with stored answers, check items and quarantine, is also driven against a real Postgres in
// humanEval.flow.spec.ts, because a preview database may hold no generated answers to rate.

test(
	'with human-eval off, the evaluation API answers 404 for everyone',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'human-eval': false });

		const signedOut = await page.request.get('/chat/api/eval/languages');
		expect(signedOut.status(), 'the languages route answered while the flag is off').toBe(404);
		const results = await page.request.get('/chat/api/eval/results?language=fra');
		expect(results.status(), 'the results route answered while the flag is off').toBe(404);

		await signInAsFreshUser(page);
		const signedIn = await page.request.get('/chat/api/eval/next?language=fra');
		expect(
			signedIn.status(),
			'the next-item route answered a signed-in account while the flag is off'
		).toBe(404);
	}
);

test(
	'with human-eval on, a signed-in person picks an open language, agrees to the consent text and is offered the worked example',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });

		// Signed out: the open languages are listed, with their varieties, and rating needs an account.
		const languages = await page.request.get('/chat/api/eval/languages');
		expect(languages.status()).toBe(200);
		const { languages: open } = (await languages.json()) as {
			languages: { id: string; dir: string; varieties: { value: string }[]; hasAnswers: boolean }[];
		};
		const french = open.find((l) => l.id === 'fra');
		expect(
			french,
			'French is not open on preview, where draft languages are meant to be'
		).toBeDefined();
		expect(french!.dir).toBe('ltr');
		expect(french!.varieties.map((v) => v.value)).toContain('other');

		const signedOutNext = await page.request.get('/chat/api/eval/next?language=fra');
		expect(signedOutNext.status(), 'an anonymous visitor was offered an answer to rate').toBe(401);

		// Results are for anyone, signed out too, and a closed language has none.
		const results = await page.request.get('/chat/api/eval/results?language=fra');
		expect(results.status(), 'an anonymous visitor could not read the results').toBe(200);
		expect((await results.json()).kind).toBe('results');
		const closedResults = await (
			await page.request.get('/chat/api/eval/results?language=zzz')
		).json();
		expect(closedResults.kind).toBe('closed');

		await signInAsFreshUser(page);

		// With no stored French answers, the person is told so before any consent (CUR-4263).
		if (!french!.hasAnswers) {
			const empty = await (await page.request.get('/chat/api/eval/next?language=fra')).json();
			expect(empty.kind, 'a language with nothing to rate went on to consent').toBe('empty');
			test.info().annotations.push({
				type: 'no-stored-answers',
				description:
					'this preview database holds no stored French answers, so consent was not reached'
			});
			return;
		}

		// Before declaring a level and agreeing, the person is shown the consent text and nothing to rate.
		const before = await (await page.request.get('/chat/api/eval/next?language=fra')).json();
		expect(before.kind).toBe('needs_profile');
		expect(before.consent.paragraphs.length).toBeGreaterThan(0);

		// A profile without consent is refused, and an unknown variety is refused.
		const noConsent = await page.request.post('/chat/api/eval/profile', {
			data: { language: 'fra', level: 'native', consent: false }
		});
		expect(noConsent.status()).toBe(400);
		const badVariety = await page.request.post('/chat/api/eval/profile', {
			data: { language: 'fra', level: 'native', variety: 'xx-XX', consent: true }
		});
		expect(badVariety.status()).toBe(400);

		const saved = await page.request.post('/chat/api/eval/profile', {
			data: { language: 'fra', level: 'native', consent: true }
		});
		expect(saved.status()).toBe(200);

		// The first time in a language, the worked example comes before any real answer.
		const after = await (await page.request.get('/chat/api/eval/next?language=fra')).json();
		expect(after.kind).toBe('calibration');
		expect(after.language).toBe('fra');
		expect(after.answer.length).toBeGreaterThan(0);

		// A language that is not open is reported as closed rather than offering anything.
		const closed = await (await page.request.get('/chat/api/eval/next?language=zzz')).json();
		expect(closed.kind).toBe('closed');
	}
);

/** Answers every question the stepper shows with its first option, then submits. */
async function answerEveryQuestion(page: Page) {
	const stepper = page.locator('[data-eval-stepper]');
	for (let i = 0; i < 12; i++) {
		const step = await stepper.getAttribute('data-eval-step');
		if (step === 'finish') break;
		await stepper.locator(`[data-eval-options="${step}"] [data-eval-option]`).first().click();
		// Picking an option moves on by itself after a beat.
		await expect(stepper).not.toHaveAttribute('data-eval-step', step!);
	}
	await expect(stepper, 'the questions never reached the submit step').toHaveAttribute(
		'data-eval-step',
		'finish'
	);
	await page.locator('[data-eval-submit]').click();
}

test(
	'with human-eval off, the evaluation page is a 404 and Contribute offers no way to it',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'human-eval': false });

		const res = await page.goto('/chat/settings/evaluate?language=fra');
		expect(res?.status(), 'the evaluation page rendered while the flag is off').toBe(404);

		await page.goto('/chat/settings/contribute');
		await expect(page.locator('[data-contribute-way]').first()).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-contribute-way="evaluate"]'),
			'Contribute links to an evaluation that would 404'
		).toHaveCount(0);
	}
);

test(
	'with human-eval on, a signed-in person goes from the sidebar’s Contribute link to the evaluation in French, and the page saves their profile and worked example through the API',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(150_000);
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });
		await signInAsFreshUser(page);

		// The sidebar's "Get involved" card leads to Contribute, which offers the evaluation in the
		// language picked there; French is a draft language, open on preview.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto('/chat', { waitUntil: 'commit' });
		// A click that lands while navigation is still slow leaves the page on Contribute, where the
		// card isn't rendered, so a retry returns once the URL already matches (SOL-238).
		const contribute = /\/chat\/settings\/contribute/;
		await expect(async () => {
			if (contribute.test(page.url())) return;
			await page.locator('[data-get-involved-link]:visible').first().click({ timeout: 3_000 });
			await page.waitForURL(contribute, { timeout: 10_000 });
		}, 'no "Get involved" link in the sidebar').toPass({ timeout: 45_000 });

		await page.locator('[data-contribute-language]').click();
		await page.getByRole('option', { name: /^French|^Français/ }).click();
		const start = page
			.locator('[data-contribute-way="evaluate"]')
			.getByRole('link', { name: /Start evaluating/ });
		await expect(start, 'Contribute offers no evaluation').toBeVisible({ timeout: 30_000 });
		await start.click();
		await page.waitForURL(/\/chat\/settings\/evaluate\?language=fra/, { timeout: 30_000 });
		// Evaluation is a settings page: the sidebar stays the settings nav, with this section current.
		await expect(
			page.locator('a[aria-current="page"]:visible', { hasText: 'Evaluate language' }),
			'evaluation left settings for the main app screen'
		).toBeVisible({ timeout: 30_000 });

		// The page talks to the API: no sample badge, and Start is offered to a signed-in account.
		await expect(page.locator('[data-eval-intro]')).toBeVisible({ timeout: 30_000 });
		await expect(
			page.locator('[data-eval-sample]'),
			'the page fell back to sample answers'
		).toHaveCount(0);
		const { languages: open } = (await (
			await page.request.get('/chat/api/eval/languages')
		).json()) as {
			languages: { id: string; hasAnswers: boolean }[];
		};
		if (!open.find((l) => l.id === 'fra')?.hasAnswers) {
			// Nothing stored to rate in French here: the page says so and offers no Start (CUR-4263).
			await expect(page.locator('[data-eval-empty-notice]')).toBeVisible();
			await expect(page.locator('[data-eval-start]')).toHaveCount(0);
			test.info().annotations.push({
				type: 'no-stored-answers',
				description: 'this preview database holds no stored French answers, so Start is not offered'
			});
			return;
		}
		await page.locator('[data-eval-start]').click();

		// The profile step offers exactly the varieties the API lists for French.
		await expect(page.locator('[data-eval-profile]')).toBeVisible({ timeout: 30_000 });
		const { languages } = (await (await page.request.get('/chat/api/eval/languages')).json()) as {
			languages: { id: string; varieties: { label: string }[] }[];
		};
		const apiVarieties = languages.find((l) => l.id === 'fra')!.varieties.map((v) => v.label);
		const shown = page
			.getByRole('group', { name: 'Variety of French' })
			// The varieties are a single-choice ToggleGroup, whose items carry role="radio".
			.getByRole('radio');
		// Compare the labels before CSS uppercasing, and wait for the complete list to render.
		await expect(
			shown,
			'the page offers varieties the API does not accept, or misses some'
		).toHaveText(apiVarieties);

		await page.locator('[data-eval-profile] label', { hasText: 'Native' }).click();
		await page
			.getByRole('group', { name: 'Variety of French' })
			.getByRole('radio', { name: apiVarieties[0], exact: true })
			.click();
		await page.locator('[data-eval-agree]').click();
		await page.getByRole('button', { name: /^Continue/ }).click();

		// The worked example first, then our rating beside theirs.
		await expect(
			page.locator('[data-eval-calibration]'),
			'no worked example after the profile'
		).toBeVisible({ timeout: 30_000 });
		await answerEveryQuestion(page);
		await expect(page.locator('[data-eval-reveal]')).toBeVisible();
		await page.locator('[data-eval-begin]').click();
		await expect(page.locator('[data-eval-page]')).not.toHaveAttribute(
			'data-eval-phase',
			/loading|profile/,
			{ timeout: 30_000 }
		);

		// The server now has the profile, the consent and the finished worked example, and French has
		// stored answers: it offers a real one, never the worked example, the consent step, or "done"
		// to someone who has rated nothing (CUR-4263).
		const next = (await (await page.request.get('/chat/api/eval/next?language=fra')).json()) as {
			kind: string;
			runId?: string;
		};
		expect(next.kind, 'the page did not save the profile and worked example through the API').toBe(
			'rate'
		);

		// A rating with every question answered is saved, and the page says so.
		await expect(page.locator('[data-eval-page]')).toHaveAttribute('data-eval-phase', 'item');
		const ratingSaved = page.waitForResponse(
			(r) => r.url().includes('/chat/api/eval/ratings') && r.request().method() === 'POST'
		);
		await answerEveryQuestion(page);
		expect((await ratingSaved).status(), 'the rating was refused').toBe(200);
		await expect(page.locator('[data-eval-saved]')).toContainText('Saved. Thank you.');

		// Rated once: the same answer is not offered again.
		const after = (await (await page.request.get('/chat/api/eval/next?language=fra')).json()) as {
			kind: string;
			runId?: string;
		};
		expect(after.runId ?? null, 'the answer just rated was offered again').not.toBe(next.runId);
	}
);

test(
	'in sample mode the page says plainly that sample ratings are not saved, and posts nothing',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(90_000);
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });
		const posted: string[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().includes('/chat/api/eval/')) posted.push(r.url());
		});

		await page.goto('/chat/settings/evaluate?sample=1&language=fra');
		await expect(page.locator('[data-eval-sample]').first()).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('[data-eval-sample-note]')).toContainText(
			'Nothing you rate here is saved.'
		);
		await page.locator('[data-eval-start]').click();

		// Under way, the settings header names the language, with Evaluate language one crumb up.
		await expect(page.locator('[data-eval-profile]')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('French');
		const crumb = page
			.getByRole('navigation', { name: 'Breadcrumb' })
			.getByRole('link', { name: 'Evaluate language' });
		await expect(crumb, 'no breadcrumb back to the language picker').toHaveAttribute(
			'href',
			'/chat/settings/evaluate?sample=1'
		);

		await page.locator('[data-eval-profile] label', { hasText: 'Native' }).click();
		await page.locator('[data-eval-agree]').click();
		await page.getByRole('button', { name: /^Continue/ }).click();
		await expect(page.locator('[data-eval-calibration]')).toBeVisible({ timeout: 30_000 });
		await answerEveryQuestion(page);
		await page.locator('[data-eval-begin]').click();

		await expect(page.locator('[data-eval-page]')).toHaveAttribute('data-eval-phase', 'item', {
			timeout: 30_000
		});
		await answerEveryQuestion(page);
		const saved = page.locator('[data-eval-saved]');
		await expect(saved).toContainText('Sample ratings aren’t saved.');
		await expect(saved, 'sample mode claims a save it never made').not.toContainText(
			'Saved. Thank you.'
		);
		expect(posted, 'sample mode posted to the evaluation API').toEqual([]);
	}
);

test(
	'picking a language shows how models do there: a share only past the thresholds, counts below them, and no zero for an unrated model',
	{ tag: ['@preview-only', '@CUR-1914'] },
	async ({ page, context, baseURL }) => {
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });
		await page.goto('/chat/settings/evaluate?sample=1&language=fra');

		const results = page.locator('[data-eval-results]');
		await expect(results, 'no results under the language picker').toBeVisible({ timeout: 30_000 });
		await expect(results.getByRole('heading')).toHaveText('How models do in French so far');

		const shown = results.locator('[data-eval-result="shown"]');
		await expect(shown.getByRole('meter')).toHaveAttribute('aria-valuenow', '0.71');
		await expect(shown).toContainText('Likely between 55% and 83%');
		await expect(shown).toContainText('Natural French');

		const below = results.locator('[data-eval-result="insufficient"]');
		await expect(below).toContainText('Not enough ratings yet: 9 of 24');
		await expect(below.getByRole('meter'), 'a share was shown below the thresholds').toHaveCount(0);

		const unrated = results.locator('[data-eval-result="none"]');
		await expect(unrated).toContainText('Nobody has rated it yet.');
		await expect(unrated, 'an unrated model was shown a zero').not.toContainText('0%');
	}
);

test(
	'an open language with no stored answers says so before consent, and never says every answer was rated',
	{ tag: ['@preview-only', '@CUR-4263'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });
		const { languages: open } = (await (
			await page.request.get('/chat/api/eval/languages')
		).json()) as { languages: { id: string; name: string; hasAnswers: boolean }[] };
		expect(open.length, 'no language is open for evaluation on preview').toBeGreaterThan(0);
		for (const l of open)
			expect(typeof l.hasAnswers, `/languages says nothing about answers in ${l.name}`).toBe(
				'boolean'
			);

		const empty = open.find((l) => !l.hasAnswers);
		if (!empty) {
			// Every open language has answers on this preview (the nightly import filled them), so the
			// empty state can't be shown here; the unit tests in humanEval/service.spec.ts pin it.
			test.info().annotations.push({
				type: 'every-open-language-has-answers',
				description: 'no open language without stored answers on this preview'
			});
			return;
		}

		await signInAsFreshUser(page);
		// Asked straight away, before any consent, the server says there is nothing to rate.
		const next = await (await page.request.get(`/chat/api/eval/next?language=${empty.id}`)).json();
		expect(next.kind, `${empty.name} offered consent with nothing to rate`).toBe('empty');

		// The page, from its own language picker: a plain "nothing yet", and no Start into consent.
		await page.goto('/chat/settings/evaluate', { waitUntil: 'commit' });
		await expect(page.locator('[data-eval-intro]')).toBeVisible({ timeout: 30_000 });
		await page.locator('[data-eval-language]').click();
		// Names like "Portuguese (Brazil)" carry regex characters; the option reads "<name> · <endonym>".
		const literal = empty.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.getByRole('option', { name: new RegExp(`^${literal}`) }).click();
		await expect(page.locator('[data-eval-empty-notice]')).toContainText(
			`There are no answers to rate in ${empty.name} yet.`
		);
		await expect(
			page.locator('[data-eval-start]'),
			`Start is offered in ${empty.name}, which has nothing to rate`
		).toHaveCount(0);
		await expect(page.locator('[data-eval-done]')).toHaveCount(0);
		await expect(page.locator('[data-eval-page]')).not.toContainText('rated every answer');
	}
);

test(
	'a language the service does not list says evaluation is not open yet, with no Start or sign-in',
	{ tag: ['@preview-only', '@CUR-4263'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'human-eval': true });
		// Preview counts drafts as open, so every language is open there; the page is handed a list that
		// omits Spanish, which is what production returns while Spanish is unchecked.
		await page.route('**/chat/api/eval/languages', async (route) => {
			await route.fulfill({
				json: {
					languages: [{ id: 'fra', name: 'French', dir: 'ltr', varieties: [], hasAnswers: true }]
				}
			});
		});
		await page.goto('/chat/settings/evaluate', { waitUntil: 'commit' });
		await expect(page.locator('[data-eval-intro]')).toBeVisible({ timeout: 30_000 });
		await page.locator('[data-eval-language]').click();
		await page.getByRole('option', { name: /^Spanish/ }).click();
		await expect(page.locator('[data-eval-not-open-notice]')).toHaveText(
			/Evaluation isn’t open in Spanish yet\. It opens once a native speaker has checked the requests\./
		);
		await expect(
			page.locator('[data-eval-start]'),
			'Start is offered in a closed language'
		).toHaveCount(0);
		await expect(
			page.locator('[data-eval-signin]'),
			'Sign in is offered in a closed language'
		).toHaveCount(0);
		await expect(
			page.locator('[data-eval-empty-notice]'),
			'a closed language got the open-but-empty message'
		).toHaveCount(0);

		// An open language is not told it is closed.
		await page.locator('[data-eval-language]').click();
		await page.getByRole('option', { name: /^French/ }).click();
		await expect(page.locator('[data-eval-not-open-notice]')).toHaveCount(0);
	}
);
