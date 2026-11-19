// e2e-product: @chat
// e2e-area: @history
// Whether a turn is sealed is the `history-seal-writes` flag, read per account. It replaced
// the CONVERSATION_SEAL_WRITES env var, so it can be staged to team accounts before everyone. An
// account turns encryption on in Settings, then sends a turn carrying a canary: with the flag on, the
// stored row holds no copy of the canary and the question is sealed; with it off, the turn is written
// in plaintext as before. Both states are forced with the fuzz override, as a team account on
// production would get them from PostHog.
import { test, expect, type Page } from './helpers/test';
import postgres from 'postgres';
import { chatEntry, chatPath } from './helpers/chatEntry';
import { setFlagOverrides } from './helpers/flagOverride';
import { signInAsFreshUser } from './helpers/session';
import { composerHydrated, sendOpensConversation } from './helpers/composer';
import { installCannedReplies, installFaultInjectionHeader } from './helpers/faultInjection';
import { turnDone } from './helpers/turn';
import { turnOnEncryption } from './helpers/historyKey';
import { sslFor } from './helpers/db';

const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;

type StoredRow = {
	text: string;
	messages: { from: string; sealed?: string; sealedMac?: string }[];
};

async function storedConversation(id: string): Promise<StoredRow> {
	const sql = postgres(DATABASE_URL!, { ssl: sslFor(DATABASE_URL!), max: 1 });
	try {
		const rows = await sql<
			{ doc: { messages: StoredRow['messages'] } }[]
		>`select doc from conversations where id = ${id}`;
		expect(rows.length, 'the conversation was never stored').toBe(1);
		return { text: JSON.stringify(rows[0].doc), messages: rows[0].doc.messages };
	} finally {
		await sql.end({ timeout: 5 });
	}
}

/** After the spec has forced the flag: an account turns encryption on and sends a canary turn; the
 *  stored row is sealed or plaintext as `sealing` says, and the chat reads back either way. */
async function canaryTurnStored(page: Page, sealing: boolean): Promise<void> {
	expect(
		DATABASE_URL,
		'SCENARIO_DATABASE_URL is unset, so the stored row cannot be read'
	).toBeTruthy();
	await signInAsFreshUser(page);
	await composerHydrated(page);
	await turnOnEncryption(page);
	await expect
		.poll(async () => (await page.request.get(chatPath('/api/v2/keys/history'))).status(), {
			message: "the account's history key was never stored",
			timeout: 30_000
		})
		.toBe(200);

	await installCannedReplies(page);
	await page.goto(chatEntry(), { waitUntil: 'load' });
	await composerHydrated(page);
	const canary = `canary-${Date.now().toString(36)}-seal-flag`;
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(`Remember the code word ${canary} and say it back`);
	await sendOpensConversation(page);
	await expect(turnDone(page.locator('[data-message-role="assistant"]').last())).toBeVisible({
		timeout: 120_000
	});
	const id = new URL(page.url()).pathname.split('/').pop()!;

	const stored = await storedConversation(id);
	const question = stored.messages.find((m) => m.from === 'user');
	expect(question, 'no user message was stored').toBeTruthy();
	if (sealing) {
		expect(stored.text, 'the canary is stored in plaintext with the flag on').not.toContain(canary);
		expect(question!.sealed, 'the question is not sealed with the flag on').toBeTruthy();
	} else {
		expect(stored.text, 'the canary is not in the stored row with the flag off').toContain(canary);
		expect(question!.sealed, 'the question was sealed with the flag off').toBeFalsy();
	}

	// Either way the chat reads back in the browser.
	await page.reload({ waitUntil: 'load' });
	await expect(page.getByText(canary).first(), 'the turn did not read back').toBeVisible({
		timeout: 30_000
	});
}

test(
	'with history-seal-writes on, an account with a history key stores its turn sealed',
	{ tag: ['@preview-only', '@CUR-5015'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'history-seal-writes': true
		});
		await canaryTurnStored(page, true);
	}
);

test(
	'with history-seal-writes off, an account with a history key stores its turn in plaintext as before',
	{ tag: ['@preview-only', '@CUR-5015'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(240_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'history-seal-writes': false
		});
		await canaryTurnStored(page, false);
	}
);

// D7: the flag decides whether a NEW chat is sealed, never whether an already-sealed one goes
// back to plaintext. A chat sealed with the flag on, continued after it is turned off, stays sealed:
// the second turn's words reach the row only sealed, and the chat still reads back in the browser.
test(
	'a chat sealed with history-seal-writes on, continued after the flag is turned off, stores no plaintext',
	{ tag: ['@preview-only', '@CUR-4983'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(300_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'history-seal-writes': true
		});
		await canaryTurnStored(page, true);
		const id = new URL(page.url()).pathname.split('/').pop()!;

		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'history-seal-writes': false
		});
		await page.reload({ waitUntil: 'load' });
		await composerHydrated(page);
		const second = `canary-${Date.now().toString(36)}-after-flag-off`;
		const composer = page.getByLabel('Message AI Potluck');
		await composer.click({ timeout: 30_000 });
		await composer.fill(`Now remember ${second} as well`);
		await composer.press('Enter');
		const assistants = page.locator('[data-message-role="assistant"]');
		await expect(assistants, 'the second turn got no answer').toHaveCount(2, { timeout: 120_000 });
		await expect(turnDone(assistants.last())).toBeVisible({ timeout: 120_000 });

		const stored = await storedConversation(id);
		expect(
			stored.text,
			'a turn with sealing off put the sealed chat back in plaintext'
		).not.toContain(second);
		expect(
			stored.messages.filter((m) => m.from === 'user').length,
			'the second question was never stored'
		).toBe(2);
		expect(
			stored.messages.filter((m) => m.from === 'user').every((m) => m.sealed),
			'a question in the sealed chat was saved unsealed with the flag off'
		).toBe(true);

		await page.reload({ waitUntil: 'load' });
		await expect(page.getByText(second).first(), 'the second turn did not read back').toBeVisible({
			timeout: 30_000
		});
	}
);

/** Send one more turn in the open chat and wait for its answer: the chat then holds `count` answers. */
async function continueChat(page: Page, text: string, count: number): Promise<void> {
	const composer = page.getByLabel('Message AI Potluck');
	await composer.click({ timeout: 30_000 });
	await composer.fill(text);
	await composer.press('Enter');
	const assistants = page.locator('[data-message-role="assistant"]');
	await expect(
		assistants,
		'a sealed chat could not be continued after the MAC key rotated'
	).toHaveCount(count, { timeout: 120_000 });
	await expect(turnDone(assistants.last())).toBeVisible({ timeout: 120_000 });
}

// D6: rotating the history MAC key must not strand a chat sealed under the old one. The chat is
// sealed under the deployment's key; then every send carries `history_mac_key_rotated`, under which the
// server holds the old key for checking and a new key as active, as an operator's rotation leaves it
// (chat/sealedTurn.ts `withE2eRotation`). The browser posts the opened history, the server accepts the
// old MACs and re-takes them under the new key, and a further turn is checked against those new MACs.
test(
	'a sealed chat continues in the browser after the MAC key rotates, and its MACs move to the new key',
	{ tag: ['@preview-only', '@CUR-4983'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(360_000);
		await setFlagOverrides(context, baseURL!, {
			'history-key-enrollment': true,
			'history-seal-writes': true
		});
		await canaryTurnStored(page, true);
		const id = new URL(page.url()).pathname.split('/').pop()!;
		const before = await storedConversation(id);
		const rotatedPrefix = 'm2.e2e-rotated.';
		expect(
			before.messages.filter((m) => m.sealed).every((m) => m.sealedMac?.startsWith('m2.')),
			'a sealed message has no key-id MAC before the rotation'
		).toBe(true);
		expect(
			before.messages.some((m) => m.sealedMac?.startsWith(rotatedPrefix)),
			'a MAC was under the rotated key before the rotation'
		).toBe(false);

		// The newest route wins, so from here every send carries the rotation fault instead of the
		// canned reply; the scenario fixture's model replay still answers the turn.
		await installFaultInjectionHeader(page, 'history_mac_key_rotated');
		await page.reload({ waitUntil: 'load' });
		await composerHydrated(page);
		const second = `canary-${Date.now().toString(36)}-after-rotation`;
		await continueChat(page, `Now remember ${second} as well`, 2);

		const after = await storedConversation(id);
		const sealed = after.messages.filter((m) => m.sealed);
		expect(
			after.messages.filter((m) => m.from === 'user').length,
			'the second question was never stored'
		).toBe(2);
		expect(
			after.messages.filter((m) => m.from === 'user').every((m) => m.sealed),
			'a question was stored unsealed after the rotation'
		).toBe(true);
		expect(after.text, 'the second question is stored in plaintext').not.toContain(second);
		expect(
			sealed.every((m) => m.sealedMac?.startsWith(rotatedPrefix)),
			'a sealed message still carries a MAC under the retired key after the turn'
		).toBe(true);

		// A third turn is checked against the MACs the rotation wrote.
		await page.reload({ waitUntil: 'load' });
		await composerHydrated(page);
		await continueChat(page, 'And say both code words back to me', 3);

		await page.reload({ waitUntil: 'load' });
		await expect(page.getByText(second).first(), 'the second turn did not read back').toBeVisible({
			timeout: 30_000
		});
	}
);
