// e2e-product: @chat
// e2e-area: @storage
import { test, expect, type Page } from './helpers/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, GetObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { freshTestEmail, signInWithEmailOtp } from './helpers/signIn';
import { setFlagOverrides } from './helpers/flagOverride';

// a self-hosted Alpha keeps people's files in its own S3-compatible bucket or on local disk.
// The app runs from the checked-out tree beside its store (storage-local.sh, storage-local.yml), so
// this spec can read the store directly and check what the backend was handed: an age file sealed to
// the owner, never the bytes the person uploaded.
//
// @local-storage: left out of every run but storage-local.yml's (SCENARIO_LOCAL_STORAGE=1), which
// runs it once per backend with CUSTODIAL_STORAGE_BACKEND set to s3 (SeaweedFS) and then to local.
const DATABASE_URL = process.env.SCENARIO_DATABASE_URL;
const BACKEND = process.env.CUSTODIAL_STORAGE_BACKEND;

/** The object's bytes, read straight from the store the app was configured with, bypassing the app. */
async function storedBytes(objectPath: string): Promise<Buffer> {
	if (BACKEND === 'local') {
		return readFile(path.join(process.env.CUSTODIAL_LOCAL_DIR!, ...objectPath.split('/')));
	}
	const res = await s3Client().send(
		new GetObjectCommand({ Bucket: process.env.CUSTODIAL_S3_BUCKET!, Key: objectPath })
	);
	return Buffer.from(await res.Body!.transformToByteArray());
}

function s3Client(): S3Client {
	return new S3Client({
		endpoint: process.env.CUSTODIAL_S3_ENDPOINT,
		region: process.env.CUSTODIAL_S3_REGION,
		forcePathStyle: true
	});
}

/** Uploads one text file through My files' own file input, retried until the request is sent: before
 *  hydration the input has no change handler yet, and a file set then is dropped. */
async function uploadThroughPage(page: Page, name: string, body: string): Promise<void> {
	await expect(async () => {
		const uploaded = page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/chat/api/storage'),
			{ timeout: 10_000 }
		);
		await page
			.locator('input[type=file]')
			.first()
			.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
		const res = await uploaded;
		expect(res.ok(), `the upload answered ${res.status()}: ${await res.text()}`).toBe(true);
	}).toPass({ timeout: 45_000 });
}

test.beforeAll(async () => {
	if (BACKEND !== 's3') return;
	// The server may not have the bucket yet. An existing one answers BucketAlreadyOwnedByYou, which is fine.
	await s3Client()
		.send(new CreateBucketCommand({ Bucket: process.env.CUSTODIAL_S3_BUCKET! }))
		.catch((e: { name?: string }) => {
			if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
		});
});

test(
	"a self-hosted Alpha keeps a person's uploaded file in its own store as ciphertext, and gives it back to them intact",
	{ tag: '@local-storage' },
	async ({ page, context, baseURL }) => {
		test.setTimeout(120_000);
		expect(['s3', 'local'], 'storage-local.sh sets CUSTODIAL_STORAGE_BACKEND').toContain(BACKEND);
		await setFlagOverrides(context, baseURL!, { 'custodial-storage-view': true });
		await signInWithEmailOtp(page, DATABASE_URL!, freshTestEmail());

		await page.goto('/chat/storage', { waitUntil: 'commit' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});

		const name = 'board-minutes.txt';
		const body = `Board minutes ${crypto.randomUUID()}\n- approve the self-hosting budget\n`;
		await uploadThroughPage(page, name, body);
		await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeVisible({
			timeout: 30_000
		});

		const listed = await page.request.get('/chat/api/storage');
		expect(listed.status()).toBe(200);
		const stored = ((await listed.json()) as { files: { path: string }[] }).files
			.map((f) => f.path)
			.find((p) => p.endsWith(`/${name}`));
		expect(stored, 'the app does not list the file it just accepted').toBeTruthy();

		// What the backend holds: an age file (CUSTODIAL_SEAL_WRITES is on), with none of the text in it.
		const raw = await storedBytes(stored!);
		expect(
			raw.subarray(0, 21).toString('latin1'),
			`${BACKEND} holds something other than an age file at ${stored}`
		).toBe('age-encryption.org/v1');
		expect(
			raw.includes(Buffer.from('self-hosting budget')),
			'the plaintext reached the store'
		).toBe(false);

		// What the person gets back through the app: their own bytes, opened with their key.
		const back = await page.request.get(
			`/chat/api/storage/file?path=${encodeURIComponent(stored!)}`
		);
		expect(back.status()).toBe(200);
		expect(await back.text()).toBe(body);

		test.info().annotations.push({
			type: 'store check',
			description: `${BACKEND}: ${stored} is ${raw.length} bytes of age ciphertext; the app returned the ${body.length}-byte original`
		});
	}
);
