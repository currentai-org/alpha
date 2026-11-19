import { redirect } from '@sveltejs/kit';
import { chatLinkHref } from '$lib/websiteLinks';
import type { RequestHandler } from './$types';

// The /alpha demo is retired: the real app on sample data, with a sidebar of made-up past chats and a
// sign-up wall on send, read to visitors as other people's conversations and a login requirement.
// Every way in now goes to the real chat, which a guest can use without signing in. On www that is
// the chat host; develop, previews and event instances still serve /chat themselves (chatLinkHref).
// A 308 so old links, bookmarks and search results land there too.
export const GET: RequestHandler = () => redirect(308, chatLinkHref('/chat'));
