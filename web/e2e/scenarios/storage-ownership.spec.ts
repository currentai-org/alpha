// e2e-product: @chat
// e2e-area: @storage
import { test, expect } from './helpers/test';
import { setFlagOverrides } from './helpers/flagOverride';
import { freshTestEmail } from './helpers/signIn';
import { signInAsFreshUser } from './helpers/session';
import { journeyStep } from './helpers/journeyStep';
import { holdForRecording } from './helpers/recording';
import type { BrowserContext, Page } from '@playwright/test';

// A3 row 18 (CUR-2797): one Hugging Face token holds every account's files (CUR-1288), so the
// ownership check in `routes/chat/api/storage/guard.ts` is all that keeps one person's files from
// another's. This drives that check against a real preview: account B, signed in, asks for and tries
// to delete a file account A stored, and must be refused without learning anything, while A's file
// stays whole. @preview-only like the rest of My files, reached through the override cookie.

const FLAGS = { 'custodial-storage-view': true };

async function signedIn(context: BrowserContext, baseURL: string): Promise<Page> {
	await setFlagOverrides(context, baseURL, FLAGS);
	const page = await context.newPage();
	await signInAsFreshUser(page, freshTestEmail());
	return page;
}

const fileUrl = (path: string) => `/chat/api/storage/file?path=${encodeURIComponent(path)}`;

test(
	'another signed-in account can neither download, delete nor overwrite a file someone stored in My files',
	{ tag: ['@preview-only', '@A3'] },
	async ({ browser, baseURL }) => {
		const owner = await browser.newContext({ baseURL });
		const other = await browser.newContext({ baseURL });
		try {
			const a = await signedIn(owner, baseURL!);
			const b = await signedIn(other, baseURL!);
			const name = `private-${Date.now()}.txt`;
			const body = `only the owner may read this ${Date.now()}`;

			const uploaded = await a.request.post('/chat/api/storage', {
				multipart: {
					folder: 'documents',
					file: { name, mimeType: 'text/plain', buffer: Buffer.from(body) }
				},
				headers: { origin: new URL(baseURL!).origin }
			});
			expect(uploaded.status(), `the owner's upload answered ${uploaded.status()}`).toBe(201);
			const listed = (await (await a.request.get('/chat/api/storage')).json()) as {
				files: { path: string }[];
			};
			const path = listed.files.map((f) => f.path).find((p) => p.endsWith(name));
			expect(path, 'the uploaded file is not in the owner’s own listing').toBeTruthy();

			const bListing = (await (await b.request.get('/chat/api/storage')).json()) as {
				files: { path: string }[];
			};
			expect(bListing.files.map((f) => f.path)).not.toContain(path);

			await journeyStep(b, 'A3', 18, async () => {
				// What B sees: their own My files, with no trace of A's file.
				await b.goto('/chat/storage', { waitUntil: 'commit' });
				await expect(b.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
					timeout: 30_000
				});
				await expect(b.getByText(name)).toHaveCount(0);
				await holdForRecording(b);

				const read = await b.request.get(fileUrl(path!));
				expect(
					[403, 404],
					`another account downloading the owner's file answered ${read.status()}`
				).toContain(read.status());
				expect(await read.text(), 'the refusal carried the owner’s bytes').not.toContain(body);

				const removed = await b.request.delete(fileUrl(path!), {
					headers: { origin: new URL(baseURL!).origin }
				});
				expect(
					[403, 404],
					`another account deleting the owner's file answered ${removed.status()}`
				).toContain(removed.status());

				// The same refusal for a path that climbs out of B's own prefix, so a malformed path and
				// someone else's path cannot be told apart (guard.ts `storageError`).
				const climbed = await b.request.get(fileUrl(`../${path}`));
				expect([400, 403, 404]).toContain(climbed.status());
				expect(await climbed.text()).not.toContain(body);

				// Write (CUR-1288): an upload whose filename climbs to the owner's full path must land in
				// B's own folder or be refused, never over A's file. The owner's read-back below catches it.
				const overwrite = await b.request.post('/chat/api/storage', {
					multipart: {
						folder: 'documents',
						file: {
							name: `../../../${path}`,
							mimeType: 'text/plain',
							buffer: Buffer.from('written by another account')
						}
					},
					headers: { origin: new URL(baseURL!).origin }
				});
				expect([201, 400, 403, 404]).toContain(overwrite.status());
				const bAfter = (await (await b.request.get('/chat/api/storage')).json()) as {
					files: { path: string }[];
				};
				for (const f of bAfter.files.filter((f) => f.path.endsWith(name))) {
					await b.request.delete(fileUrl(f.path), {
						headers: { origin: new URL(baseURL!).origin }
					});
				}
			});

			const still = await a.request.get(fileUrl(path!));
			expect(still.status(), 'the owner can no longer download their own file').toBe(200);
			expect(
				await still.text(),
				'the owner’s file changed after the other account’s attempts'
			).toBe(body);

			await a.request.delete(fileUrl(path!), { headers: { origin: new URL(baseURL!).origin } });
		} finally {
			await owner.close();
			await other.close();
		}
	}
);
