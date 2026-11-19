import ChatMessage from './ChatMessage.harness.svelte';
import { render, cleanup } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '$lib/chat/types/Message';
import { generateHistoryIdentity } from '$lib/chat/crypto/historyIdentity';
import { MessageUpdateType, type MessageUpdate } from '$lib/chat/types/MessageUpdate';
import { isConversationGenerationActive } from '$lib/chat/utils/generationState';
import { openConversationDoc, sealEnvelope } from '$lib/chat/crypto/sealedHistory';
import type { SealableConversation } from '$lib/chat/crypto/sealedShape';

// A conversation as the page shows it: the doc goes through the read path's
// `openConversationDoc` in a real Chromium (WebCrypto, typage's age), and every message of the view it
// returns renders through ChatMessage, as ChatWindow renders them.

const CONV = 'conv-sealed-1';
const OTHER_CONV = 'conv-sealed-2';
const QUESTION = 'Which river runs through Niamey?';
const ANSWER = 'The Niger runs through Niamey.';

// The answer's skeleton keeps each update's structure, so a locked answer still reads as finished.
const finishedSkeleton = [{ type: MessageUpdateType.FinalAnswer, interrupted: false }] as unknown as MessageUpdate[];

async function sealedOnlyDoc(recipient: string, conversationId = CONV): Promise<SealableConversation> {
	const seal = (messageId: string, content: string) =>
		sealEnvelope(recipient, { v: 1, kind: 'message', conversationId, messageId, rev: 1, body: { content } });
	return {
		id: conversationId,
		title: '',
		messages: [
			{ id: 'q1', from: 'user', content: '', children: ['a1'], sealedRev: 1, sealed: await seal('q1', QUESTION) },
			{
				id: 'a1',
				from: 'assistant',
				content: '',
				ancestors: ['q1'],
				sealedRev: 1,
				updates: finishedSkeleton,
				sealed: await seal('a1', ANSWER)
			}
		]
	};
}

async function renderConversation(doc: SealableConversation, identity: string | null, urlId = CONV) {
	const view = await openConversationDoc(doc, urlId, identity);
	for (const message of view.messages as Message[]) {
		await render(ChatMessage, { message, loading: false });
	}
	return view.messages as Message[];
}

const slot = (id: string) => page.elementLocator(document.querySelector(`[data-message-id="${id}"]`)!);

afterEach(() => {
	cleanup();
});

describe('a conversation whose doc holds only sealed text', () => {
	it('renders the opened question and answer when the history key is unlocked', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		await renderConversation(await sealedOnlyDoc(recipient), identity);
		await expect.element(page.getByText(QUESTION)).toBeInTheDocument();
		await expect.element(page.getByText(ANSWER)).toBeInTheDocument();
		expect(document.querySelector('[data-testid="sealed-message"]')).toBeNull();
	});

	it('shows a locked placeholder for each message, and no ciphertext, when the key is locked', async () => {
		const { recipient } = await generateHistoryIdentity();
		const doc = await sealedOnlyDoc(recipient);
		const messages = await renderConversation(doc, null);
		// Locked is not still generating: the page shows no Stop and starts no poller for it.
		expect(isConversationGenerationActive(messages)).toBe(false);
		await expect.element(slot('q1')).toHaveAttribute('data-sealed-state', 'locked');
		await expect.element(slot('a1')).toHaveAttribute('data-sealed-state', 'locked');
		expect(page.getByText('This message is locked').all()).toHaveLength(2);
		const text = document.body.textContent ?? '';
		expect(text).not.toContain(QUESTION);
		expect(text).not.toContain(ANSWER);
		for (const m of doc.messages) expect(text).not.toContain(m.sealed!.slice(0, 24));
	});
});

describe('a conversation in legacy plaintext', () => {
	it('renders as it always has, with no sealed state anywhere', async () => {
		const { identity } = await generateHistoryIdentity();
		const doc: SealableConversation = {
			id: CONV,
			title: 'Rivers',
			messages: [
				{ id: 'q1', from: 'user', content: QUESTION, children: ['a1'] },
				{ id: 'a1', from: 'assistant', content: ANSWER, ancestors: ['q1'] }
			]
		};
		await renderConversation(doc, identity);
		await expect.element(page.getByText(QUESTION)).toBeInTheDocument();
		await expect.element(page.getByText(ANSWER)).toBeInTheDocument();
		expect(document.querySelector('[data-testid="sealed-message"]')).toBeNull();
	});
});

describe("a sealed blob moved into another message's slot", () => {
	it("refuses to show it there: the slot says it can't be opened and the moved text appears nowhere in it", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const doc = await sealedOnlyDoc(recipient);
		// The answer's slot now holds the question's blob, as a server that swapped rows would serve it.
		doc.messages[1].sealed = doc.messages[0].sealed;
		await renderConversation(doc, identity);

		await expect.element(slot('a1')).toHaveAttribute('data-sealed-state', 'unreadable');
		await expect.element(page.getByText("Can't open this message")).toBeInTheDocument();
		expect(slot('a1').element().textContent).not.toContain(QUESTION);
		expect(page.getByText(QUESTION).all()).toHaveLength(1);
		expect(document.body.textContent).not.toContain(ANSWER);
	});
});

describe("conversation B's doc served at A's URL", () => {
	it('opens nothing: every slot says it cannot be opened and none of B shows', async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const docB = await sealedOnlyDoc(recipient, OTHER_CONV);
		const messages = await renderConversation(docB, identity, CONV);

		await expect.element(slot('q1')).toHaveAttribute('data-sealed-state', 'unreadable');
		await expect.element(slot('a1')).toHaveAttribute('data-sealed-state', 'unreadable');
		expect(isConversationGenerationActive(messages)).toBe(false);
		const text = document.body.textContent ?? '';
		expect(text).not.toContain(QUESTION);
		expect(text).not.toContain(ANSWER);
	});
});
