// e2e-product: @chat
// e2e-area: @admin
import { test, expect, type Page } from './helpers/test';
import type { APIResponse } from '@playwright/test';
import postgres from 'postgres';
import { signInWithRole, type StaffRole } from './helpers/adminRole';
import { sslFor } from './helpers/db';

// CUR-3991 (under CUR-927): each staff role reaches the admin routes its grants allow and is refused
// the rest, signed in as a person rather than through the shared password. The role holder is a
// fresh example.org user seeded in the preview's own database, so this runs on every PR preview.
//
// Nothing here changes what visitors get. A save that the role is allowed is sent with a stale
// `expectedEditedAt`, so it passes the permission gate and stops at the conflict check (409) without
// writing. A refused one never reaches the write at all. `try` is sent without a query, so a
// permitted call stops at the body check (400) and runs no model.

const STALE = '1970-01-01T00:00:00.000Z';

function databaseUrl(): string {
	const url = process.env.SCENARIO_DATABASE_URL;
	if (!url)
		throw new Error('SCENARIO_DATABASE_URL is not set: global-setup.ts should have caught this');
	return url;
}

/** A form action's own status. SvelteKit answers a `fail()` with HTTP 200 and the status in the body. */
async function actionStatus(
	page: Page,
	path: string,
	fields: Record<string, string>
): Promise<number> {
	const res = await page.request.post(path, {
		form: fields,
		headers: {
			accept: 'application/json',
			origin: new URL(page.url()).origin,
			'x-sveltekit-action': 'true'
		}
	});
	const body = (await res.json().catch(() => null)) as { type?: string; status?: number } | null;
	return body?.type === 'failure' && body.status ? body.status : res.status();
}

async function tryDraft(page: Page): Promise<APIResponse> {
	return page.request.post('/chat/admin/tuning/try', { data: {} });
}

async function pageStatus(page: Page, path: string): Promise<number> {
	return (await page.request.get(path, { maxRedirects: 0 })).status();
}

async function asRole(page: Page, role: StaffRole): Promise<void> {
	await signInWithRole(page, databaseUrl(), role);
}

test(
	'an operator can try a tuning draft and open journeys and audit, but is refused tuning save, RAG writes and report detail',
	{ tag: ['@admin-roles', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await asRole(page, 'operator');

		expect((await tryDraft(page)).status(), 'tuning try refused an operator').toBe(400);
		expect(await pageStatus(page, '/chat/admin/journeys'), 'journeys').toBe(200);
		expect(await pageStatus(page, '/chat/admin/audit'), 'audit').toBe(200);

		expect(
			await actionStatus(page, '/chat/admin/tuning?/save', { expectedEditedAt: STALE }),
			'an operator saved tuning'
		).toBe(403);
		expect(
			(await page.request.post('/chat/admin/rag/ingest', { data: {} })).status(),
			'an operator wrote to RAG'
		).toBe(403);
		// Report detail turns a role without `reports:read` back to the admin home, never to the report.
		expect(
			await pageStatus(page, '/chat/admin/reports/000000000000000000000000'),
			'an operator opened a report'
		).toBe(303);
	}
);

test(
	'an editor gets past the gate on a tuning save, but is refused report detail',
	{ tag: ['@admin-roles', '@preview-only'] },
	async ({ page }) => {
		test.setTimeout(120_000);
		await asRole(page, 'editor');

		expect(
			await actionStatus(page, '/chat/admin/tuning?/save', { expectedEditedAt: STALE }),
			'the tuning save stopped before the conflict check'
		).toBe(409);
		expect(
			await pageStatus(page, '/chat/admin/reports/000000000000000000000000'),
			'an editor opened a report'
		).toBe(303);

		// The portal opens to the panel list, with no sign-in prompt in its place (CUR-3992).
		await page.goto('/chat/admin');
		await expect(page.getByRole('link', { name: /^Tuning\b/ })).toBeVisible();
		await expect(page.locator('[data-staff-sign-in]')).toHaveCount(0);
	}
);

test(
	'an admin opens report detail, and a signed-out request is refused with 401',
	{ tag: ['@admin-roles', '@preview-only'] },
	async ({ page, playwright, baseURL }) => {
		test.setTimeout(120_000);
		await asRole(page, 'admin');
		// An id no conversation has: an admin gets past the gate to the lookup, which answers 404.
		expect(await pageStatus(page, '/chat/admin/reports/000000000000000000000000')).toBe(404);

		const anon = await playwright.request.newContext({ baseURL });
		try {
			expect((await anon.post('/chat/admin/tuning/try', { data: {} })).status()).toBe(401);
		} finally {
			await anon.dispose();
		}
	}
);

test(
	'an admin opening an unreported conversation sees no content until a reason is given, and the read is logged with it',
	{ tag: ['@admin-roles', '@preview-only'] },
	async ({ page }) => {
		// The admin's own fresh conversation stands in for anyone's: nobody has reported it,
		// so there is no report id to cite and the page must ask why before showing anything.
		test.setTimeout(120_000);
		await asRole(page, 'admin');
		const models = (await (await page.request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const created = await page.request.post('/chat/conversation', {
			data: { model: models[0]?.id ?? models[0]?.name }
		});
		expect(created.ok(), `POST /chat/conversation answered ${created.status()}`).toBe(true);
		const { conversationId } = (await created.json()) as { conversationId: string };
		const title = `Reason gate ${Date.now()}`;
		const titled = await page.request.patch(`/chat/api/v2/conversations/${conversationId}`, {
			data: { title }
		});
		expect(titled.ok(), `PATCH title answered ${titled.status()}`).toBe(true);

		await page.goto(`/chat/admin/reports/${conversationId}`);
		await expect(
			page.getByRole('heading', { name: 'Why are you opening this conversation?' })
		).toBeVisible();
		// The chat sidebar lists the admin's own conversations, this one included, so look for the
		// title where the transcript would put it rather than anywhere on the page.
		await expect(page.getByRole('heading', { name: title })).toHaveCount(0);

		const reason = 'CUR-4385: e2e check of the reason gate';
		await page.getByLabel('Reason').fill(reason);
		await page.getByRole('button', { name: 'Open the conversation' }).click();
		await expect(page.getByRole('heading', { name: title })).toBeVisible();
		await expect(page.getByText(`This read is logged with its reason: ${reason}`)).toBeVisible();

		const sql = postgres(databaseUrl(), { ssl: sslFor(databaseUrl()), max: 1 });
		try {
			// The audit write does not hold up the page, so wait for the row rather than read it once.
			await expect
				.poll(async () =>
					(
						await sql`select summary from admin_audit
							where action = 'report.view' and target = ${conversationId}`
					).map((r) => r.summary)
				)
				.toEqual([`reason: ${reason}`]);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
);

test(
	'a browser holding a shared-password admin cookie from before CUR-3992 is signed out everywhere',
	{ tag: ['@admin-roles', '@preview-only'] },
	async ({ playwright, baseURL }) => {
		// The shape the retired login issued: `<user>.<expiry>.<hmac>`, unexpired. Its proof cannot be
		// valid here, and that is the point: no value of this cookie opens anything any more.
		const origin = new URL(baseURL ?? '').origin;
		const stale = await playwright.request.newContext({
			baseURL,
			storageState: {
				cookies: [
					{
						name: 'admin',
						value: `admin.${Date.now() + 86_400_000}.${'0'.repeat(64)}`,
						domain: new URL(origin).hostname,
						path: '/',
						expires: -1,
						httpOnly: true,
						secure: origin.startsWith('https:'),
						sameSite: 'Strict'
					}
				],
				origins: []
			}
		});
		try {
			expect(
				(await stale.post('/chat/admin/tuning/try', { data: {} })).status(),
				'tuning try'
			).toBe(401);
			expect((await stale.get('/chat/api/v2/debug/config')).status(), 'debug config').toBe(401);
			expect(
				(await stale.get('/chat/admin/journeys/published')).status(),
				'the published gallery'
			).toBe(404);
			const portal = await stale.get('/chat/admin');
			expect(portal.status()).toBe(200);
			expect(await portal.text(), 'the portal shows its sign-in prompt').toContain(
				'data-staff-sign-in'
			);
		} finally {
			await stale.dispose();
		}
	}
);
