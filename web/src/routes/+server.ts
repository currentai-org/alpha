import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The snapshot ships chat without the website, so its root is the chat. */
export const GET: RequestHandler = () => {
	redirect(307, '/chat');
};
