import { describe, expect, it } from 'vitest';
import { Encrypter } from 'age-encryption';
import type { Message } from '$lib/chat/types/Message';
import { MessageUpdateStatus, MessageUpdateType, type MessageUpdate } from '$lib/chat/types/MessageUpdate';
import { deriveMessageStatus, isAssistantGenerationTerminal } from '$lib/chat/utils/generationState';
import { generateHistoryIdentity } from './historyIdentity';
import { openConversationDoc, openSealedMessage, openSealedText, sealEnvelope } from './sealedHistory';
import { rememberSent, sealedHistoryForTurn } from './openedHistory';
import { hasSealedFields, showsClosedSealedParts, type SealableConversation } from './sealedShape';

// The read path's pure function: a doc plus an unlocked identity in, the plaintext view out.
// Real age throughout (typage's Encrypter/Decrypter, a real hybrid identity), so the binding checks run
// against blobs that genuinely decrypt.

const CONV = 'conv-aaaa';
const OTHER_CONV = 'conv-bbbb';
const REV = 3;

const ANSWER_UPDATES: MessageUpdate[] = [
	{ type: MessageUpdateType.Stream, token: 'Ouaga' },
	{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished, message: 'Done, said privately.' },
	{ type: MessageUpdateType.FinalAnswer, text: 'Ouagadougou.', interrupted: false }
];

const userSkeleton = (id: string): Message => ({
	id,
	from: 'user',
	content: '',
	ancestors: [],
	children: ['m2'],
	sealedRev: REV
});
const assistantSkeleton = (id: string): Message => ({
	id,
	from: 'assistant',
	content: '',
	ancestors: ['m1'],
	sealedRev: REV,
	routerMetadata: { route: 'default', model: 'mistral-large-3' },
	files: [
		{ type: 'hash', name: '', value: 'sha-abc', mime: 'text/plain' },
		{ type: 'hash', name: '', value: 'sha-def', mime: 'text/plain' }
	],
	// The writer keeps each update's structure in the skeleton and seals its text.
	updates: [
		{ type: MessageUpdateType.Stream },
		{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
		{ type: MessageUpdateType.FinalAnswer, interrupted: false }
	] as unknown as MessageUpdate[]
});

const sealMessage = (recipient: string, messageId: string, body: Record<string, unknown>, conversationId = CONV, rev = REV) =>
	sealEnvelope(recipient, { v: 1, kind: 'message', conversationId, messageId, rev, body });

async function sealedDoc(recipient: string, conversationId = CONV): Promise<SealableConversation> {
	const m1 = userSkeleton('m1');
	m1.sealed = await sealMessage(recipient, 'm1', { content: 'What is the capital of Burkina Faso?' }, conversationId);
	const m2 = assistantSkeleton('m2');
	m2.sealed = await sealMessage(
		recipient,
		'm2',
		{
			content: 'Ouagadougou.',
			reasoning: 'Recall the capital.',
			updates: ANSWER_UPDATES,
			calculations: [{ expression: '1+1', result: '2' }],
			opinions: [{ model: 'm', modelShort: 'm', openness: 'open', sovereign: true, answer: 'Also Ouagadougou.' }],
			mcpCalls: [{ server: 's', tool: 't', outcome: 'ok', ms: 3, output: 'tool output' }],
			// Keyed by hash, so the names cannot be shuffled onto the wrong file by order.
			fileNames: { 'sha-def': 'second.txt', 'sha-abc': 'notes.txt' }
		},
		conversationId
	);
	return {
		id: conversationId,
		title: '',
		sealedTitle: await sealEnvelope(recipient, { v: 1, kind: 'title', conversationId, rev: REV, text: 'Capitals' }),
		sealedTitleRev: REV,
		sealedPreprompt: await sealEnvelope(recipient, {
			v: 1,
			kind: 'preprompt',
			conversationId,
			rev: REV,
			text: 'Answer briefly.'
		}),
		sealedPrepromptRev: REV,
		messages: [m1, m2]
	};
}

describe('openConversationDoc: personal instructions apply', () => {
	it('keeps showing the personal instructions the server sent, and still keeps the opened preprompt for the turn', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = { ...(await sealedDoc(recipient)), preprompt: 'Call me Sam.', personalInstructionsApply: true };
		const view = await openConversationDoc(doc, CONV, identity);
		expect(view.preprompt).toBe('Call me Sam.');
		expect(view.prepromptState).toBeUndefined();
		expect(sealedHistoryForTurn(CONV, []).sealedPreprompt).toEqual({ rev: REV, text: 'Answer briefly.' });
	});
});

describe('openConversationDoc: what a locked tab sent itself', () => {
	it('shows the preprompt and root it sent at their revision without a key, and stays locked for any other revision', async () => {
		const { recipient } = await generateHistoryIdentity();
		const conv = 'conv-sent-here';
		const doc = await sealedDoc(recipient, conv);
		rememberSent(conv, { rev: REV, text: 'Answer briefly.' }, [
			{ id: 'm1', rev: REV, body: { content: 'What is the capital of Burkina Faso?' } }
		]);
		const view = await openConversationDoc(doc, conv, null);
		expect(view.preprompt).toBe('Answer briefly.');
		expect(view.prepromptState).toBeUndefined();
		expect(view.messages[0].content).toBe('What is the capital of Burkina Faso?');
		expect(view.messages[0].sealedState).toBeUndefined();
		expect(view.messages[1].sealedState).toBe('locked');
		expect(view.titleState).toBe('locked');

		const later = await openConversationDoc({ ...doc, sealedPrepromptRev: REV + 1 }, conv, null);
		expect(later.prepromptState).toBe('locked');
	});
});

describe('openConversationDoc: legacy plaintext', () => {
	it('returns a conversation with nothing sealed as the same object, untouched, with or without a key', async () => {
		const doc: SealableConversation = {
			id: CONV,
			title: 'Plain',
			preprompt: 'Be kind.',
			messages: [{ id: 'm1', from: 'user', content: 'hello' }]
		};
		const snapshot = structuredClone(doc);
		expect(hasSealedFields(doc)).toBe(false);
		expect(await openConversationDoc(doc, CONV, null)).toBe(doc);
		const { identity } = await generateHistoryIdentity();
		expect(await openConversationDoc(doc, CONV, identity)).toBe(doc);
		expect(doc).toEqual(snapshot);
	});
});

describe('openConversationDoc: sealed, unlocked', () => {
	it('opens every sealed message, the title and the preprompt, and keeps the plaintext skeleton', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		const view = await openConversationDoc(doc, CONV, identity);

		expect(view.title).toBe('Capitals');
		expect(view.preprompt).toBe('Answer briefly.');
		expect(view.titleState).toBeUndefined();
		for (const k of ['sealedTitle', 'sealedTitleRev', 'sealedPreprompt', 'sealedPrepromptRev']) {
			expect(k in view).toBe(false);
		}
		expect(showsClosedSealedParts(view)).toBe(false);

		const [m1, m2] = view.messages;
		expect(m1.content).toBe('What is the capital of Burkina Faso?');
		expect(m1.sealed).toBeUndefined();
		expect(m1.sealedState).toBeUndefined();
		expect(m1.children).toEqual(['m2']);
		expect(m2.content).toBe('Ouagadougou.');
		expect(m2.reasoning).toBe('Recall the capital.');
		expect(m2.updates).toEqual(ANSWER_UPDATES);
		expect(m2.calculations).toEqual([{ expression: '1+1', result: '2' }]);
		expect(m2.routerMetadata).toEqual({ route: 'default', model: 'mistral-large-3' });
		expect(m2.ancestors).toEqual(['m1']);
	});

	it('names each file by its hash, whatever order the names were sealed in', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const [, m2] = (await openConversationDoc(await sealedDoc(recipient), CONV, identity)).messages;
		expect(m2.files?.map((f) => [f.value, f.name])).toEqual([
			['sha-abc', 'notes.txt'],
			['sha-def', 'second.txt']
		]);
	});

	it('opens fields no one listed as sealed (opinions, mcpCalls): sealed is the default', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const [, m2] = (await openConversationDoc(await sealedDoc(recipient), CONV, identity)).messages;
		expect(m2.opinions?.[0].answer).toBe('Also Ouagadougou.');
		expect(m2.mcpCalls?.[0].output).toBe('tool output');
	});

	it('reads every sealed field from the blob, never from plaintext left beside it in the skeleton', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		Object.assign(doc.messages[0], {
			content: 'stale plaintext',
			reasoning: 'stale reasoning',
			opinions: [{ answer: 'stale opinion' }],
			mcpCalls: [{ output: 'stale output' }],
			mathLedger: { lines: [] },
			unrunCode: { reason: 'wrote-not-run' },
			leftOutFiles: [{ name: 'stale.txt', mime: 'text/plain' }],
			mcp: { tool: 'stale' },
			futureField: 'stale future text'
		});
		doc.messages[1].files![0].name = 'stale-name.txt';
		for (const identityOrNull of [identity, null]) {
			const [m1, m2] = (await openConversationDoc(doc, CONV, identityOrNull)).messages;
			expect(JSON.stringify(m1)).not.toContain('stale');
			expect(JSON.stringify(m2)).not.toContain('stale');
		}
	});
});

describe('openConversationDoc: body fields of the wrong shape are dropped', () => {
	it('drops a field whose shape is wrong and keeps the rest of the message', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const m = assistantSkeleton('m2');
		// Parsed from JSON, so `__proto__` is an own key here, as it would be in a hostile envelope.
		const body = JSON.parse(
			'{"__proto__":{"polluted":true},"content":"Still here.","updates":"not an array",' +
				'"calculations":{"expression":"1+1"},"webSearch":"a string","reasoning":42,' +
				'"historyLeftOut":"many","fileNames":["notes.txt"],"notAMessageField":"dropped"}'
		);
		m.sealed = await sealMessage(recipient, 'm2', body);
		const opened = await openSealedMessage(m, CONV, identity);
		expect(opened.sealedState).toBeUndefined();
		expect(opened.content).toBe('Still here.');
		for (const k of ['calculations', 'webSearch', 'reasoning', 'historyLeftOut', 'notAMessageField', 'polluted']) {
			expect(k in opened).toBe(false);
		}
		expect(Object.getPrototypeOf(opened)).toBe(Object.prototype);
		// The skeleton's structural updates stand in for the dropped ones, and no file takes a name.
		expect(opened.updates?.map((u) => u.type)).toEqual(['stream', 'status', 'finalAnswer']);
		expect(opened.files?.map((f) => f.name)).toEqual(['', '']);
	});

	it('drops an update entry that is not an update, and a content that is not a string', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const m = assistantSkeleton('m2');
		m.sealed = await sealMessage(recipient, 'm2', {
			content: ['not', 'text'],
			updates: [null, 'x', { no: 'type' }, ANSWER_UPDATES[2]]
		});
		const opened = await openSealedMessage(m, CONV, identity);
		expect(opened.content).toBe('');
		expect(opened.updates).toEqual([ANSWER_UPDATES[2]]);
	});
});

describe('openConversationDoc: locked identity', () => {
	it('shows locked placeholders with no text and no ciphertext when there is no unlocked key', async () => {
		const { recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		doc.messages[1].content = 'stale plaintext';
		const view = await openConversationDoc(doc, CONV, null);

		expect(view.messages.map((m) => m.sealedState)).toEqual(['locked', 'locked']);
		expect(view.messages.map((m) => m.content)).toEqual(['', '']);
		expect(view.title).toBe('');
		expect(view.titleState).toBe('locked');
		expect(view.preprompt).toBe('');
		expect(view.prepromptState).toBe('locked');
		expect(showsClosedSealedParts(view)).toBe(true);

		const rendered = JSON.stringify(view);
		for (const blob of [doc.sealedTitle!, doc.sealedPreprompt!, ...doc.messages.map((m) => m.sealed!)]) {
			expect(rendered).not.toContain(blob.slice(0, 40));
		}
		expect(rendered).not.toContain('stale plaintext');
	});

	it('keeps a locked answer finished: its skeleton updates still end the turn, with none of their text', async () => {
		const { recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		// A writer that left text in the skeleton's updates does not get it shown either.
		doc.messages[1].updates = ANSWER_UPDATES;
		const [, answer] = (await openConversationDoc(doc, CONV, null)).messages;

		expect(answer.sealedState).toBe('locked');
		expect(isAssistantGenerationTerminal(answer)).toBe(true);
		expect(deriveMessageStatus(answer)).toBe('complete');
		expect(answer.updates).toEqual([
			{ type: 'stream' },
			{ type: 'status', status: 'finished' },
			{ type: 'finalAnswer', interrupted: false }
		]);
	});

	it('keeps an unreadable answer finished too', async () => {
		const sealer = await generateHistoryIdentity();
		const other = await generateHistoryIdentity();
		const [, answer] = (await openConversationDoc(await sealedDoc(sealer.recipient), CONV, other.identity)).messages;
		expect(answer.sealedState).toBe('unreadable');
		expect(isAssistantGenerationTerminal(answer)).toBe(true);
	});

	it('refuses with unreadable, not locked, when the key held is not the one the blob was sealed to', async () => {
		const sealer = await generateHistoryIdentity();
		const other = await generateHistoryIdentity();
		const view = await openConversationDoc(await sealedDoc(sealer.recipient), CONV, other.identity);
		expect(view.messages.map((m) => m.sealedState)).toEqual(['unreadable', 'unreadable']);
		expect(view.titleState).toBe('unreadable');
	});
});

describe('binding: a blob opens only in the slot it was sealed for', () => {
	it("refuses a message's blob moved into another message's slot in the same conversation", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		doc.messages[1].sealed = doc.messages[0].sealed;
		const [m1, m2] = (await openConversationDoc(doc, CONV, identity)).messages;
		expect(m1.content).toBe('What is the capital of Burkina Faso?');
		expect(m2.sealedState).toBe('unreadable');
		expect(m2.content).toBe('');
	});

	it("refuses a message's blob moved into the same message id in another conversation", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		const moved = await openSealedMessage(doc.messages[0], OTHER_CONV, identity);
		expect(moved.sealedState).toBe('unreadable');
		expect(moved.content).toBe('');
	});

	it('refuses a title blob read as a preprompt or another conversation’s title', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		const refused = { text: '', state: 'unreadable' };
		expect(await openSealedText(doc.sealedTitle!, 'preprompt', CONV, REV, identity)).toEqual(refused);
		expect(await openSealedText(doc.sealedTitle!, 'title', OTHER_CONV, REV, identity)).toEqual(refused);
	});

	it('refuses a title blob placed in a message slot', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		const m = { ...doc.messages[0], sealed: doc.sealedTitle };
		expect((await openSealedMessage(m, CONV, identity)).sealedState).toBe('unreadable');
	});

	it('refuses an envelope of another version, one with no ids, one with no rev, and one that is not JSON', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const seal = async (text: string) => {
			const e = new Encrypter();
			e.addRecipient(recipient);
			return btoa(String.fromCharCode(...(await e.encrypt(text))));
		};
		const base = userSkeleton('m1');
		for (const plaintext of [
			JSON.stringify({ v: 2, kind: 'message', conversationId: CONV, messageId: 'm1', rev: REV, body: { content: 'x' } }),
			JSON.stringify({ v: 1, kind: 'message', rev: REV, body: { content: 'x' } }),
			JSON.stringify({ v: 1, kind: 'message', conversationId: CONV, messageId: 'm1', body: { content: 'x' } }),
			'just text'
		]) {
			const opened = await openSealedMessage({ ...base, sealed: await seal(plaintext) }, CONV, identity);
			expect(opened.sealedState).toBe('unreadable');
			expect(opened.content).toBe('');
		}
	});

	it('refuses a blob that is not an age file at all', async () => {
		const { identity } = await generateHistoryIdentity();
		const opened = await openSealedMessage({ ...userSkeleton('m1'), sealed: btoa('not age') }, CONV, identity);
		expect(opened.sealedState).toBe('unreadable');
	});
});

describe("binding to the URL's conversation id, not the doc's", () => {
	it("opens nothing of conversation B's doc served at A's URL", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const docB = await sealedDoc(recipient, OTHER_CONV);
		const view = await openConversationDoc(docB, CONV, identity);
		expect(view.messages.map((m) => m.sealedState)).toEqual(['unreadable', 'unreadable']);
		expect(view.titleState).toBe('unreadable');
		expect(view.prepromptState).toBe('unreadable');
		const rendered = JSON.stringify(view);
		for (const text of ['Burkina', 'Ouagadougou', 'Capitals', 'Answer briefly']) expect(rendered).not.toContain(text);
	});

	it("opens nothing of a doc whose id is not the URL's, even when its blobs are bound to the URL's id", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient, CONV);
		doc.id = OTHER_CONV;
		const view = await openConversationDoc(doc, CONV, identity);
		expect(view.messages.map((m) => m.sealedState)).toEqual(['unreadable', 'unreadable']);
		expect(view.titleState).toBe('unreadable');
		expect(JSON.stringify(view)).not.toContain('Burkina');
	});
});

describe('freshness: a blob opens only at the revision its slot names', () => {
	it('refuses an older message blob put back under a newer skeleton', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const m = userSkeleton('m1');
		m.sealed = await sealMessage(recipient, 'm1', { content: 'the old text' }, CONV, REV - 1);
		const opened = await openSealedMessage(m, CONV, identity);
		expect(opened.sealedState).toBe('unreadable');
		expect(opened.content).toBe('');
	});

	it('refuses a message blob when the skeleton names no revision', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const m = userSkeleton('m1');
		m.sealed = await sealMessage(recipient, 'm1', { content: 'x' });
		delete m.sealedRev;
		expect((await openSealedMessage(m, CONV, identity)).sealedState).toBe('unreadable');
	});

	it('refuses an older title or preprompt blob', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedDoc(recipient);
		doc.sealedTitleRev = REV + 1;
		doc.sealedPrepromptRev = REV + 1;
		const view = await openConversationDoc(doc, CONV, identity);
		expect(view.titleState).toBe('unreadable');
		expect(view.prepromptState).toBe('unreadable');
		expect(view.messages[0].content).toBe('What is the capital of Burkina Faso?');
	});
});
