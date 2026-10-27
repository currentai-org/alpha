// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { modelWithoutTools, pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { turnDone } from './helpers/turn';
import { warmupContext } from './helpers/warmup';
import { startChattingPastWelcome } from './helpers/welcome';

// Math routing (CUR-2065, CUR-2198). With `math-routing` on, the turn planner (one forced plan_turn call
// on ARITHMETIC_ROUTE_MODEL) decides on every turn whether the latest message asks for a number to be
// worked out and records the setup; code sums it and shows rows plus a "Total: N (arithmetic checked by
// code)" line, and the chat's model writes the words. Only a model that cannot call tools is planned
// (CUR-2282), since a tool-capable one calls `calculate` itself, so every spec here starts on the first
// listed model without tools rather than the target's default. Every planned turn persists a `math-route` rung
// whose outcome is "ok" only when the math field produced a ledger (conversation/[id]/+server.ts), so each
// turn asserts the checked line with the right number AND that the planner produced it (CUR-2149). When
// the plan misses, the turn must carry no checked line at all (CUR-2134), and the answer model's own copy
// of the stamp is removed on every turn, so a turn shows at most the one stamp code wrote (CUR-2199). A
// miss the lane caused gets one regenerate before it fails; one our prompt or schema caused fails at once
// (see ledgerTurn).
//
// Three turns, because follow-ups are where the old guard lost the base case (CUR-2011) and the regex
// floor that preceded the planner missed turns with no digits and no question (CUR-2198): turn 3, "A
// full-time colleague resigned as well.", only reaches the ledger if the planner reads the conversation,
// and only comes out at 9 if the ledger is rebuilt from all of it.
//
// Preview-only: the flag is forced through the fuzz_override cookie, which production refuses.
test(
	'with math-routing on, a three-turn FTE question with two resignations gets a code-checked total that is right every time',
	{ tag: ['@preview-only', '@CUR-2065', '@CUR-2198'] },
	async ({ page, context, baseURL }) => {
		// Three real turns of up to 60s each, after up to 60s of setup.
		test.setTimeout(260_000);
		await setFlagOverrides(context, baseURL!, { 'math-routing': true });

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry((await modelWithoutTools(page.request)).id), {
			waitUntil: 'commit'
		});

		const composer = page.getByLabel('Message AI Potluck');
		const assistant = page.locator('[data-message-role="assistant"]');
		let conversationId = '';

		// The `math-route` rung's outcome on the stored message the page is showing, found by the id the
		// page renders, so a retried turn reads its new answer rather than the one it replaced. Undefined
		// when the turn never routed.
		async function storedOutcome(messageId: string | null): Promise<string | undefined> {
			const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
			expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
			const body = (await res.json()) as {
				json?: {
					messages?: Array<{ id: string; rungs?: Array<{ rung: string; outcome?: string }> }>;
				};
			};
			const stored = (body.json?.messages ?? []).find((m) => m.id === messageId);
			expect(
				stored,
				`the page shows message ${messageId}, which is not in the stored conversation`
			).toBeTruthy();
			return stored?.rungs?.find((r) => r.rung === 'math-route')?.outcome;
		}

		async function finished(message: typeof assistant, turn: number): Promise<void> {
			await expect(
				turnDone(message),
				`turn ${turn} never finished within 60s` + warmupContext()
			).toBeVisible({ timeout: 60_000 });
		}

		// Which path answered, split by whose fault a miss is. `invalid`, `missing`, `unparsable` and
		// `no-call` mean the model did not produce a usable plan from our prompt and tool schema: that is
		// ours, and fails at once. `timeout` and `failed` come from the lane (the 8s plan deadline, a
		// gateway error): the turn is regenerated once, and only a second lane miss fails, named as the
		// lane. Healthy previews miss about 1 in 80 ledger turns (log line
		// `[math-routing] ledger`): 3 timeouts, 2 no-calls.
		async function ledgerTurn(turn: number): Promise<string> {
			const message = assistant.nth(turn - 1);
			let id = await message.getAttribute('data-message-id');
			let outcome = await storedOutcome(id);
			const laneMiss = (o: string | undefined) => o === 'timeout' || o === 'failed';
			if (laneMiss(outcome)) {
				// With no ledger (CUR-2134), nothing on the turn may claim code checked the arithmetic, and
				// no calc fence may stand in for one.
				const missed = await message.innerText();
				expect(
					missed,
					`turn ${turn}: the ledger ${outcome}, yet the answer carries a checked total: "${missed.slice(0, 400)}"`
				).not.toMatch(/checked by code/);
				await expect(
					message.locator('pre'),
					`turn ${turn}: the ledger ${outcome}, and the answer renders a code block where a calc fence used to stand in`
				).toHaveCount(0);
				test.info().annotations.push({
					type: 'ledger-lane-retry',
					description: `turn ${turn}: ledger ${outcome}, regenerated once`
				});
				const replaced = id;
				await message.getByRole('button', { name: 'Retry' }).click();
				await expect(message).not.toHaveAttribute('data-message-id', replaced ?? '', {
					timeout: 30_000
				});
				await finished(message, turn);
				id = await message.getAttribute('data-message-id');
				outcome = await storedOutcome(id);
				expect(
					laneMiss(outcome) ? undefined : outcome,
					`turn ${turn}: the plan lane missed twice ("${outcome}" after a first miss): the 8s deadline or the gateway, not our prompt or schema. The provider is on the \`[turn-plan] plan\` log line.`
				).toBeDefined();
			}
			expect(
				outcome,
				`turn ${turn}: the math-route rung reads "${outcome}". "ok" means the planner built a ledger; "not-asked" means it read the turn as no calculation; "invalid", "missing", "unparsable" or "no-call" means our prompt or tool schema got no usable plan; undefined means the turn was never planned`
			).toBe('ok');
			const text = await message.innerText();
			// The code-rendered ledger carries no "checked by code" label, and CUR-2199 removes any
			// the answer model copies from an older answer, so none may remain.
			expect(
				text,
				`turn ${turn}: a "checked by code" label reached the page: "${text.slice(0, 600)}"`
			).not.toMatch(/checked by code/);
			return text;
		}

		async function ask(text: string, turn: number): Promise<void> {
			await composer.click({ timeout: 30_000 });
			await composer.fill(text);
			await composer.press('Enter');
			await finished(assistant.nth(turn - 1), turn);
		}

		await ask(
			'My team has 12 people and 3 of them work part time at 50 percent. How many full time equivalents is that?',
			1
		);
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		expect(conversationId, `no conversation id in ${page.url()}`).not.toBe('');
		const first = await ledgerTurn(1);
		expect(
			first,
			`turn 1: expected the ledger's "Total: 10.5" line, got: "${first.slice(0, 400)}"`
		).toMatch(/^Total:\s*10\.5\b/m);

		await ask("One of the part timers just resigned. What's the number now?", 2);
		const second = await ledgerTurn(2);
		expect(
			second,
			`turn 2: expected the ledger's "Total: 10" line, got: "${second.slice(0, 400)}"`
		).toMatch(/^Total:\s*10\b(?![.,]\d)/m);

		await ask('A full-time colleague resigned as well.', 3);
		const third = await ledgerTurn(3);
		expect(
			third,
			`turn 3: expected the ledger's "Total: 9" line, got: "${third.slice(0, 400)}"`
		).toMatch(/^Total:\s*9\b(?![.,]\d)/m);
	}
);

// A summary request whose text happens to hold "4,000 over budget" and "from 20 to 25" is
// planned like every turn. The planner's math field says whether a calculation was asked at all; when
// it says no, the turn gets no ledger and is answered as any other. Before the fix this exact message came back with "Total: **4,005** EUR
// (arithmetic checked by code)" above the summary. The stored rung is read as well as the page: a
// ledger that timed out would also print no total, and that is the lane's miss, not this contract.
test(
	'with math-routing on, a request to summarise an agenda that contains figures gets no code-checked total',
	{ tag: ['@preview-only', '@CUR-2161'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(140_000);
		await setFlagOverrides(context, baseURL!, { 'math-routing': true });

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry((await modelWithoutTools(page.request)).id), {
			waitUntil: 'commit'
		});

		const composer = page.getByLabel('Message AI Potluck');
		const message = page.locator('[data-message-role="assistant"]').first();
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			[
				'Can you summarise this agenda in three bullet points for our board?',
				'',
				'1. Welcome and apologies',
				"2. Treasurer's report: the roof repair came in 4,000 over budget",
				'3. Vote on raising membership fees from 20 to 25',
				'4. Summer fete: volunteers needed for the tea tent',
				'5. Any other business'
			].join('\n')
		);
		await composer.press('Enter');
		await expect(
			turnDone(message),
			'the summary never finished within 60s' + warmupContext()
		).toBeVisible({
			timeout: 60_000
		});
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		expect(conversationId, `no conversation id in ${page.url()}`).not.toBe('');

		const text = await message.innerText();
		expect(
			text,
			`a summary request got a code-checked total it never asked for: "${text.slice(0, 400)}"`
		).not.toMatch(/arithmetic checked by code/);

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{ id: string; rungs?: Array<{ rung: string; outcome?: string }> }>;
			};
		};
		const id = await message.getAttribute('data-message-id');
		const outcome = body.json?.messages
			?.find((m) => m.id === id)
			?.rungs?.find((r) => r.rung === 'math-route')?.outcome;
		expect(
			outcome,
			`the math-route rung reads "${outcome}". "not-asked" means the planner declined the ledger; "ok" means it built one for a summary; "timeout" or "failed" is the lane, so this run proves nothing either way`
		).toBe('not-asked');
	}
);

// A money total reads in cents (CUR-2206). Without that, this question
// gets "Total: 59.699875 USD (arithmetic checked by code)" and "Your total is $59.699875" in the
// prose, which repeats the note's "the total is exactly" figure. The rows keep their precision, since
// they are the working; the total and the prose do not. The rung is read so that a ledger the lane
// missed (no total at all) is named as the lane, not passed as cents.
test(
	'with math-routing on, a shopping total with sales tax reads in cents, not six decimals',
	{ tag: ['@preview-only', '@CUR-2206'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(140_000);
		await setFlagOverrides(context, baseURL!, { 'math-routing': true });

		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(pinnedChatEntry((await modelWithoutTools(page.request)).id), {
			waitUntil: 'commit'
		});

		const composer = page.getByLabel('Message AI Potluck');
		const message = page.locator('[data-message-role="assistant"]').first();
		await composer.click({ timeout: 30_000 });
		await composer.fill(
			'I bought 3 notebooks at $4.75 each, 2 pens at $1.20 each, and a backpack for $38.50. Sales tax is 8.25%. What is my total?'
		);
		await composer.press('Enter');
		await expect(
			turnDone(message),
			'the shopping total never finished within 60s' + warmupContext()
		).toBeVisible({ timeout: 60_000 });
		await page.waitForURL(/\/(alpha\/)?chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
		const conversationId = page.url().match(/\/conversation\/([a-f0-9]+)/)?.[1] ?? '';
		expect(conversationId, `no conversation id in ${page.url()}`).not.toBe('');

		const res = await page.request.get(`/chat/api/v2/conversations/${conversationId}`);
		expect(res.ok(), `reading the stored conversation answered ${res.status()}`).toBe(true);
		const body = (await res.json()) as {
			json?: {
				messages?: Array<{ id: string; rungs?: Array<{ rung: string; outcome?: string }> }>;
			};
		};
		const id = await message.getAttribute('data-message-id');
		const outcome = body.json?.messages
			?.find((m) => m.id === id)
			?.rungs?.find((r) => r.rung === 'math-route')?.outcome;
		expect(
			outcome,
			`the math-route rung reads "${outcome}". "ok" means the ledger answered; "timeout" or "failed" is the lane, so this run proves nothing about the format`
		).toBe('ok');

		const text = await message.innerText();
		expect(
			text,
			`expected the ledger's "Total: 59.70 …" line, got: "${text.slice(0, 500)}"`
		).toMatch(/^Total:\s*59\.70\b/m);
		expect(
			text,
			`the answer still states the total to six decimals: "${text.slice(0, 500)}"`
		).not.toMatch(/59\.699875/);
	}
);
