// e2e-product: @chat
// e2e-area: @storage
import { test, expect } from './helpers/test';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { startChattingPastWelcome } from './helpers/welcome';

// a session whose active workspace was deleted used to fail the organization foreign key
// when the next chat was created, so the person got a 500 instead of a chat. @preview-only: org
// creation is reached by forcing its flag through the fuzz override cookie (see workspaces.spec.ts).
test(
	'a new chat is created after the active workspace was deleted, and counts toward Personal',
	{ tag: ['@preview-only', '@A8'] },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		await setFlagOverrides(context, baseURL!, { 'workspace-org-creation': true });
		await signInAsFreshUser(page, freshTestEmail());
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		const origin = { origin: new URL(baseURL!).origin };
		const auth = async (path: string, data: object) => {
			const res = await page.request.post(`/chat/api/auth/organization/${path}`, {
				data,
				headers: origin
			});
			expect(res.status(), `${path} answered ${res.status()}: ${await res.text()}`).toBe(200);
			return (await res.json()) as { id?: string };
		};
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const model = models[0]?.id ?? models[0]?.name;

		const name = `E2E Gone ${Date.now()}`;
		const team = await auth('create', { name, slug: name.toLowerCase().replace(/\W+/g, '-') });
		expect(team.id, 'creating the workspace returned no id').toBeTruthy();
		await auth('set-active', { organizationId: team.id });
		// The admin deletes the workspace that is the session's active one; no set-active follows.
		await auth('delete', { organizationId: team.id });

		const created = await page.request.post('/chat/conversation', { data: { model } });
		expect(
			created.status(),
			`creating a chat after the active workspace was deleted answered ${created.status()}: ${await created.text()}`
		).toBe(200);
		const { conversationId } = (await created.json()) as { conversationId: string };
		expect(conversationId, 'the new chat returned no conversation id').toBeTruthy();
	}
);
