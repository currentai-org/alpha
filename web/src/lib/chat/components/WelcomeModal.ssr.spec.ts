import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import WelcomeModal from './WelcomeModal.svelte';

vi.mock('$app/state', () => ({ page: { data: {} } }));

// The welcome is open on first paint, so it has to be in the server's HTML. Inside a portal it
// renders nothing on the server and appears only after hydration, over a message box the visitor may
// already be typing in. (SOL-345)
describe('the first-run welcome is in the server-rendered HTML', () => {
	it('renders its dialog and its "Welcome to Alpha" title on the server', () => {
		const { body } = render(WelcomeModal, {
			props: { onTakeTour: () => {}, onStartChatting: () => {}, onDismiss: () => {} }
		});
		expect(
			body,
			'no data-welcome in the server HTML: is the welcome inside a Portal without `disabled`? A portal mounts only in the browser'
		).toContain('data-welcome');
		expect(body).toContain('Welcome to Alpha');
		expect(body).toContain('role="dialog"');
	});
});
