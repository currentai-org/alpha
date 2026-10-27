import ChatSearchDialog from './ChatSearchDialog.svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => nav);

// The sidebar has loaded 30 chats; the one to find is older than all of them, so only the server's
// answer can surface it (CUR-2630). That the server reads past the first page, by a word said in the
// messages, is searchConversations.spec.ts's claim; this is the dialog's half: it asks, shows the
// hit as a chat, and opens it (SOL-195).
// e2e-moved: scenarios/chat-search.spec.ts › search chats finds a chat past the sidebar's first 30 by a word in its messages, and opens it
const loaded = Array.from({ length: 30 }, (_, i) => ({
	id: `recent${i}`,
	title: `Recent chat ${i}`,
	updatedAt: new Date()
}));

// The "Ask Alpha: …" row repeats the query, so it matches whatever was typed; it is not a result.
const chat = (title: string) =>
	page.getByRole('option').filter({ hasText: title, hasNotText: 'Ask Alpha' });

function answer(conversations: unknown[]) {
	return vi.fn(async () => new Response(JSON.stringify({ conversations }), { status: 200 }));
}

afterEach(() => {
	vi.unstubAllGlobals();
	nav.goto.mockClear();
});

describe('Search chats', () => {
	it("asks the server, lists a chat past the sidebar's first 30 as a result, and opens it", async () => {
		const fetchMock = answer([
			{
				id: 'oldest',
				title: 'Trip to Lisbon',
				updatedAt: '2026-01-02T00:00:00Z',
				snippet: '…code word quillowend…'
			}
		]);
		vi.stubGlobal('fetch', fetchMock);
		render(ChatSearchDialog, { open: true, conversations: loaded });

		await page.getByRole('textbox', { name: 'Search chats' }).fill('quillowend');
		const result = chat('Trip to Lisbon');
		await expect.element(result, { timeout: 5_000 }).toBeVisible();

		// The query travels in the body, never the URL, because request logs keep the URL (CUR-4546).
		expect(fetchMock).toHaveBeenCalledWith(
			'/chat/api/conversations/search',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ q: 'quillowend' }) })
		);
		await result.click();
		expect(nav.goto).toHaveBeenCalledWith('/chat/conversation/oldest');
	});

	it('still lists the loaded titles that match when the server search fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 500 }))
		);
		render(ChatSearchDialog, { open: true, conversations: loaded });

		await page.getByRole('textbox', { name: 'Search chats' }).fill('Recent chat 7');
		await expect.element(chat('Recent chat 7')).toBeVisible();
		await expect.element(chat('Recent chat 1')).not.toBeInTheDocument();
	});
});
