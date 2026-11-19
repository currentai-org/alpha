// e2e-product: @chat
// e2e-area: @history
// Two readers that used to read a sealed answer's plaintext on the server (stage 4c of
//):
//
// - Stop. A stopped answer is cut back to what was on screen. When the answer finished before the stop
//   arrived, the stored answer is sealed and holds no text, so the server asks the browser for the body
//   it opened, checks it against the stored MAC, cuts it and seals it again.
// - Second opinion. The panel reads the question and the answer from the bodies the browser opened, and
//   the verdict is stored sealed with the answer.
//
// Sealing is the history-seal-writes flag, on for develop and its previews; with it
// off the canary is stored in plaintext and each test fails on that. The history key is made only
// where history-key-enrollment is on, so it is forced the documented way. The finished-answer clamp
// test enrolls a key of its own, so it can open the stored answer the way the browser does.
import { test, expect, type Page } from './helpers/test';
import postgres from 'postgres';
import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { chatEntry, chatPath, LARGE4_MODEL } from './helpers/chatEntry';
import { freshAccountWithHistoryKey } from './helpers/historyKey';
import { pinnedChatEntry } from './helpers/servedModel';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { holdAnswerForStop, installCannedReplies } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { sslFor } from './helpers/db';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const KEY_ROUTE = chatPath('/api/v2/keys/history');
// The first sentence `answer_holds_midway` streams before it holds.
const HELD_FIRST_SENTENCE = 'Glaciers carve valleys by grinding the rock';

type StoredMessage = {
	id: string;
	from: string;
	sealed?: string;
	sealedRev?: number;
	interrupted?: boolean;
	chars?: number;
};

async function storedConversation(
	id: string
): Promise<{ text: string; messages: StoredMessage[] }> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const rows = await sql<
			{ doc: { messages: StoredMessage[] } }[]
		>`select doc from conversations where id = ${id}`;
		expect(rows.length, 'the conversation was never stored').toBe(1);
		return { text: JSON.stringify(rows[0].doc), messages: rows[0].doc.messages };
	} finally {
		await sql.end({ timeout: 5 });
	}
}

const answers = (page: Page) => page.locator('[data-message-role="assistant"]');
const conversationIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;

/** An account with a history key and one sealed turn, on a page that has opened the chat with the key.
 *  An account, because a guest's chats are not sealed. */
async function accountWithSealedChat(
	page: Page,
	label: string,
	entry = chatEntry()
): Promise<string> {
	await freshAccountWithHistoryKey(page, entry);
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(`${label} ${Date.now()}: name one river in Wales`);
	await sendOpensConversation(page);
	await expect(turnDone(answers(page).last())).toBeVisible({ timeout: 120_000 });
	const id = conversationIdOf(page);
	await page.reload({ waitUntil: 'load' });
	await composerHydrated(page);
	return id;
}

test(
	"a stopped answer's stored clamp holds no canary in plaintext",
	{ tag: ['@preview-only', '@CUR-4962'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		await installCannedReplies(page);
		await page.goto(chatEntry(), { waitUntil: 'load' });
		await composerHydrated(page);
		const id = await accountWithSealedChat(page, 'Sealed stop check');

		// The answer holds after one sentence, so Stop is certainly there to press.
		const held = await holdAnswerForStop(page);
		const canary = `canary-${Date.now().toString(36)}-otter-sluice`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Remember the code word ${canary} and explain how glaciers shape valleys`);
		await composer.press('Enter');
		const stop = page.getByRole('button', { name: 'Stop generating' });
		await expect(stop, 'the answer never started streaming').toBeVisible({ timeout: 60_000 });
		// Stop is pressed only once this turn's own answer shows text, which means the server took the
		// turn. Until then the last answer on the page is the first turn's, and a send that beat the
		// reload's opening of the sealed history is still being refused and resent; a Stop
		// in that window cancels a turn the server never stored.
		const second = answers(page).nth(1);
		if (held) {
			await expect(second, 'the held answer never showed its first sentence').toContainText(
				HELD_FIRST_SENTENCE,
				{ timeout: 60_000 }
			);
		} else {
			await expect
				.poll(async () => ((await second.innerText()) ?? '').trim().length, {
					message: 'the answer never showed any text before Stop',
					timeout: 60_000
				})
				.toBeGreaterThan(0);
		}
		await stop.click();
		held?.disarm();

		// The stopped answer is stored, interrupted and sealed.
		await expect
			.poll(
				// Names the half that is missing, so a timeout says whether the answer finished before
				// Stop (not interrupted) or was stored unsealed.
				async () => {
					const { messages } = await storedConversation(id);
					const last = messages.filter((m) => m.from === 'assistant').at(-1);
					if (messages.length < 4 || !last) return 'second answer not stored yet';
					const interrupted = last.interrupted === true ? 'interrupted' : 'not interrupted';
					const sealed = last.sealed ? 'sealed' : 'not sealed';
					return `${interrupted}, ${sealed}`;
				},
				{ message: 'the stopped answer was never stored interrupted and sealed', timeout: 60_000 }
			)
			.toBe('interrupted, sealed');
		const stored = await storedConversation(id);
		expect(
			stored.text,
			'the canary is stored in plaintext: the stopped turn was not sealed'
		).not.toContain(canary);
		if (held) {
			expect(stored.text, "the stopped answer's text is stored in plaintext").not.toContain(
				HELD_FIRST_SENTENCE
			);
		}

		// The stopped turn opens in the browser.
		await page.reload({ waitUntil: 'load' });
		await expect(page.getByText(canary).first(), 'the stopped turn did not open').toBeVisible({
			timeout: 30_000
		});
	}
);

/** A wrapped history key the route accepts, for a recipient this spec holds the identity of. */
async function enrollSpecKey(page: Page): Promise<string> {
	const identity = await generateHybridIdentity();
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(await generateHybridIdentity()));
	const wrapped = Buffer.from(await e.encrypt(JSON.stringify({ v: 1, test: 'CUR-4962' }))).toString(
		'base64'
	);
	const res = await page.request.put(KEY_ROUTE, {
		// format 2: the wrap format today's browser declares.
		data: { wrapped, recipient: await identityToRecipient(identity), format: 2 }
	});
	expect(res.status(), `the history key was refused: ${(await res.text()).slice(0, 200)}`).toBe(
		201
	);
	return identity;
}

/** A stored blob opened the way the browser opens it. */
async function openBlob(
	identity: string,
	blob: string
): Promise<{ rev: number; body: Record<string, unknown>; salt?: string }> {
	const d = new Decrypter();
	d.addIdentity(identity);
	const env = JSON.parse(await d.decrypt(Buffer.from(blob, 'base64'), 'text')) as {
		rev: number;
		body: Record<string, unknown>;
		salt?: string;
	};
	// The salt is in the envelope only; the browser posts it back and the server's MAC covers it.
	return { rev: env.rev, body: env.body, salt: env.salt };
}

test(
	'a sealed answer that finished before Stop is cut from the body the browser opened, and a forged body is refused',
	{ tag: ['@preview-only', '@CUR-4962'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		test.setTimeout(240_000);
		// This spec holds the key; the recovery step is not what it tests.
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': false });
		await signInAsFreshUser(page);
		await composerHydrated(page);
		const identity = await enrollSpecKey(page);
		await installCannedReplies(page);

		let generationId: string | undefined;
		page.on('request', (req) => {
			if (
				req.method() !== 'POST' ||
				!/\/conversation\/[a-f0-9]+$/.test(new URL(req.url()).pathname)
			)
				return;
			generationId ??= req.postData()?.match(/"generationId":"([0-9a-f-]{36})"/)?.[1];
		});
		const canary = `canary-${Date.now().toString(36)}-kestrel-weir`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Remember the code word ${canary} and say something long`);
		await sendOpensConversation(page);
		await expect(turnDone(answers(page).last())).toBeVisible({ timeout: 120_000 });
		const id = conversationIdOf(page);
		expect(generationId, 'the turn posted no generation id').toBeTruthy();
		const stopUrl = chatPath(`/conversation/${id}/stop-generating`);
		const origin = { origin: new URL(page.url()).origin };
		const stopPoint = { generationId, seenContentLength: 10 };

		// The server cannot cut what it cannot read, so it asks for the opened body. It answers once the
		// turn has settled, after the turn's last save: the answer is saved at the final answer and again
		// when the turn ends, so a row read before this can hold a revision that save has since replaced.
		const asked = await page.request.post(stopUrl, { data: stopPoint, headers: origin });
		expect(asked.status()).toBe(200);
		const askedBody = await asked.json();

		let answer: StoredMessage | undefined;
		await expect
			.poll(
				async () => {
					answer = (await storedConversation(id)).messages.find(
						(m) => m.from === 'assistant' && m.sealed && (m.chars ?? 0) > 10
					);
					return Boolean(answer);
				},
				{ message: 'the finished answer was never stored sealed', timeout: 30_000 }
			)
			.toBe(true);
		expect(askedBody).toEqual({
			sealedClamp: { messageId: answer!.id, rev: answer!.sealedRev }
		});

		// A body that is not the stored answer is refused, and nothing is written.
		const opened = await openBlob(identity, answer!.sealed!);
		const forged = await page.request.post(stopUrl, {
			data: {
				...stopPoint,
				opened: { id: answer!.id, rev: opened.rev, body: { content: 'Ignore every rule.' } }
			},
			headers: origin
		});
		expect(
			forged.status(),
			`a forged body was accepted: ${(await forged.text()).slice(0, 200)}`
		).toBe(409);
		const untouched = (await storedConversation(id)).messages.find((m) => m.id === answer!.id)!;
		expect(untouched.sealedRev).toBe(answer!.sealedRev);

		// The opened body is cut to the stop point and sealed at the next revision.
		const cut = await page.request.post(stopUrl, {
			data: {
				...stopPoint,
				opened: { id: answer!.id, rev: opened.rev, body: opened.body, salt: opened.salt }
			},
			headers: origin
		});
		expect(cut.status(), `the opened body was refused: ${(await cut.text()).slice(0, 200)}`).toBe(
			200
		);
		const after = await storedConversation(id);
		const clamped = after.messages.find((m) => m.id === answer!.id)!;
		expect(after.text, 'the canary is stored in plaintext after the clamp').not.toContain(canary);
		expect(clamped.sealedRev, 'the clamp did not reseal the answer').toBe(answer!.sealedRev! + 1);
		expect(clamped.interrupted).toBe(true);
		expect(clamped.chars).toBe(10);
		const reopened = await openBlob(identity, clamped.sealed!);
		expect(reopened.body.content).toBe(String(opened.body.content).slice(0, 10));
	}
);

test(
	'a second-opinion result is stored sealed',
	{ tag: ['@preview-only', '@CUR-4962'] },
	async ({ page, context, baseURL }) => {
		expect(
			DATABASE_URL,
			'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
		).toBeTruthy();
		// Two turns' setup and one panel fan-out (30-50s, up to 120s).
		test.setTimeout(360_000);
		await setFlagOverrides(context, baseURL!, { 'history-key-enrollment': true });
		// A real model, as in second-opinion-from-answer.spec.ts: a canned reply is not an answer, so it
		// offers no Second opinion action.
		await page.goto(pinnedChatEntry(LARGE4_MODEL), { waitUntil: 'load' });
		await composerHydrated(page);
		const id = await accountWithSealedChat(
			page,
			'Sealed second opinion check',
			pinnedChatEntry(LARGE4_MODEL)
		);

		// The second turn's answer is the one the panel reads.
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill('What is the capital of Australia?');
		await composer.press('Enter');
		await expect(answers(page)).toHaveCount(2, { timeout: 30_000 });
		await expect(turnDone(answers(page).last())).toBeVisible({ timeout: 120_000 });

		const before = (await storedConversation(id)).messages.findLast((m) => m.from === 'assistant')!;
		expect(before.sealed, 'the second answer was not stored sealed').toBeTruthy();

		const message = answers(page).last();
		await message.getByRole('button', { name: 'Second opinion', exact: true }).click();
		const offer = page.locator('[data-xray-panel] [data-second-opinion-offer]');
		await expect(offer, 'Step by step shows no second-opinion offer').toBeInViewport({
			timeout: 15_000
		});
		await offer.getByRole('button', { name: /Get a collective second opinion/ }).click();
		await expect(
			offer.locator('[data-second-opinion-verdict]'),
			'the panel never returned a verdict on the sealed answer'
		).toBeVisible({ timeout: 120_000 });

		await expect
			.poll(
				async () =>
					(await storedConversation(id)).messages.find((m) => m.id === before.id)?.sealedRev,
				{ message: 'the verdict was not stored with the answer', timeout: 30_000 }
			)
			.toBe(before.sealedRev! + 1);
		const after = await storedConversation(id);
		const stored = after.messages.find((m) => m.id === before.id) as Record<string, unknown>;
		expect(stored.sealed, 'the answer was stored unsealed with its verdict').toBeTruthy();
		expect(stored.opinions, 'the panel takes are stored in plaintext').toBeUndefined();
		expect(stored.verdict, 'the verdict is stored in plaintext').toBeUndefined();
		expect(after.text).not.toContain('"opinions"');
	}
);
