// On the composed self-host stack as `selfhost/smoke.sh` booted it (no speech, agent, judge or classifier
// endpoint set), the features that are on in production and default on for a self-host work, and the ones
// that wait on a service are named in the boot log with the setting that turns them on, and
// Settings → Connectors is there for a signed-in person.
//
//   cd web && pnpm exec playwright test --config=e2e/selfhost-flags.config.ts
// Run by the source repository's self-host CI before the steps that recreate the web service.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { compose, signInByEmailCode } from './selfhost-stack';

const base = (process.env.SELFHOST_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const headers = { Origin: base };

// A one-page PDF with a line of text and no pictures, so the document check has nothing to scan.
const TINY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 50 Td (self-host smoke) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF
`;

test('the self-host defaults that are on work for a signed-in person: a PDF is stored, a workspace is made, a finished turn can be followed', async ({
	browser
}) => {
	const context = await browser.newContext({ baseURL: base });
	try {
		const request = context.request;
		await signInByEmailCode(request, base, `selfhost-flags-${randomUUID()}@example.org`);

		// document-attachments: a PDF is accepted, not refused with "can't be added on this deployment yet".
		const pdf = await request.post('/chat/api/storage', {
			headers,
			multipart: {
				folder: 'documents',
				file: { name: 'smoke.pdf', mimeType: 'application/pdf', buffer: Buffer.from(TINY_PDF) }
			}
		});
		const pdfBody = await pdf.text();
		expect(pdf.status(), `a PDF upload answered: ${pdfBody.slice(0, 200)}`).toBeLessThan(300);
		expect(pdfBody).not.toMatch(/PDF and Word files can't be added/);
		console.log(`SELFHOST FLAGS document-attachments: PDF stored (${pdf.status()})`);

		// workspace-org-creation: the organization routes exist (404 while the flag is off).
		const org = await request.post('/chat/api/auth/organization/create', {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { name: 'Smoke workspace', slug: `smoke-${randomUUID().slice(0, 8)}` }
		});
		expect(org.status(), `creating a workspace answered: ${(await org.text()).slice(0, 200)}`).toBe(
			200
		);
		console.log('SELFHOST FLAGS workspace-org-creation: workspace created');

		// stream-follow: a finished turn's recorded stream answers a follower (404 while the flag is off).
		const models = (await (await request.get('/chat/api/models')).json()) as {
			id?: string;
			name?: string;
		}[];
		const model = models[0]?.id ?? models[0]?.name;
		expect(model, 'the stack advertises a model').toBeTruthy();
		const created = await request.post('/chat/conversation', { headers, data: { model } });
		expect(created.ok(), 'a conversation is created').toBe(true);
		const { conversationId } = (await created.json()) as { conversationId: string };
		const generationId = randomUUID();
		const turn = await request.post(`/chat/conversation/${conversationId}`, {
			headers,
			timeout: 280_000,
			multipart: {
				data: JSON.stringify({
					inputs: 'Reply with one short sentence: what is the capital of France?',
					id: randomUUID(),
					is_retry: false,
					generationId
				})
			}
		});
		expect(turn.ok(), `the turn answered ${turn.status()}`).toBe(true);
		await turn.body();
		const follow = await request.get(
			`/chat/conversation/${conversationId}/generation/${generationId}`
		);
		expect(follow.status(), 'following the finished turn is answered, not 404').toBe(200);
		console.log('SELFHOST FLAGS stream-follow: a finished turn was followed');
	} finally {
		await context.close();
	}
});

test('a signed-in person on a fresh self-host stack reaches Settings → Connectors from the settings nav and can add a server', async ({
	browser
}) => {
	// mcp-servers defaults on for a self-host: with it off, the nav has no Connectors entry and
	// /chat/settings/connectors answers 404.
	const context = await browser.newContext({ baseURL: base });
	try {
		await signInByEmailCode(
			context.request,
			base,
			`selfhost-connectors-${randomUUID()}@example.org`
		);
		const page = await context.newPage();
		await page.goto('/chat/settings');
		await page
			.getByRole('link', { name: /connectors/i })
			.first()
			.click();
		await expect(page).toHaveURL(/\/settings\/connectors/);
		await expect(page.getByRole('heading', { name: 'Add your own server' })).toBeVisible();
		console.log('SELFHOST FLAGS mcp-servers: Settings → Connectors reached from the nav');
	} finally {
		await context.close();
	}
});

test('the boot log names each service-backed feature left off and the setting that turns it on', () => {
	const log = compose(['logs', '--no-color', '--no-log-prefix', 'web']);
	const wants: [string, string][] = [
		['s1-safety-judge', 'ZENTROPI_S1_ENDPOINT_URL'],
		['violence-recheck', 'GUARD_SHADOW_URL'],
		['support-signal-classifier', 'GUARD_SHADOW_URL'],
		['read-aloud', 'READ_ALOUD_BASE_URL'],
		['agent-run-handoff', 'AGENT_SERVICE_URL']
	];
	for (const [flag, env] of wants) {
		expect(log, `the boot log names ${flag} and ${env}`).toMatch(
			new RegExp(`\\[flags\\] self-host: ${flag} is off until [^"]*${env}`)
		);
	}
	const lines = log.split('\n').filter((l) => l.includes('[flags] self-host:'));
	console.log(
		`SELFHOST FLAGS boot log: ${lines.length} features named\n${lines.map((l) => l.slice(0, 240)).join('\n')}`
	);
});
