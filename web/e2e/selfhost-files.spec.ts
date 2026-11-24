// On the composed self-host stack, a signed-in person attaches a file in a chat and finds it in My files,
// kept on the store the stack is configured with and no Hugging Face bucket. The stack runs
// with selfhost/.env written from .env.example, so what is proven here is what a forker gets: uploads on
// by the self-host edition's default with the scan choice .env.example makes, and My files on because
// CUSTODIAL_STORAGE_BACKEND names a store.
//
// Run by the source repository's self-host CI twice, once per backend:
//   cd web && SELFHOST_FILES_BACKEND=local pnpm exec playwright test --config=e2e/selfhost-files.config.ts
//   (after the web service is recreated on the s3 profile's SeaweedFS)
//   cd web && SELFHOST_FILES_BACKEND=s3 SELFHOST_COMPOSE_PROFILE=local,s3 pnpm exec playwright test ...
// Environment: SELFHOST_FILES_BACKEND (local or s3, required), SELFHOST_BASE_URL (default
// http://localhost:3000), CUSTODIAL_S3_BUCKET (default alpha-files), SELFHOST_FILES_EXPECT_SEALED (1 when
// the workflow turned sealing on in selfhost/.env the way the README says, so the text-file test requires an
// age file in the store rather than accepting plaintext), and selfhost-stack.ts's.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { compose, dismissWelcome, signInByEmailCode } from './selfhost-stack';

const base = (process.env.SELFHOST_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const BACKEND = process.env.SELFHOST_FILES_BACKEND;
const BUCKET = process.env.CUSTODIAL_S3_BUCKET || 'alpha-files';
const EXPECT_SEALED = process.env.SELFHOST_FILES_EXPECT_SEALED === '1';

/** The stored object's bytes, read from the store itself rather than through the app. */
function storedBytes(objectPath: string): string {
	// The web image has no cat (distroless), so Node reads the file.
	if (BACKEND === 'local')
		return compose([
			'exec',
			'web',
			'node',
			'-e',
			'process.stdout.write(require("fs").readFileSync(process.argv[1]))',
			`/data/files/${objectPath}`
		]);
	// The filer's HTTP API, which compose keeps on the SeaweedFS container's loopback: an S3 object
	// lives at /buckets/<bucket>/<key>.
	return compose([
		'exec',
		'seaweedfs',
		'wget',
		'-q',
		'-O',
		'-',
		`http://127.0.0.1:8888/buckets/${BUCKET}/${objectPath}`
	]);
}

/** The first bytes of the stored object, base64, read from the store itself. An image may be re-encoded
 *  on the way in, so the image test checks its kind rather than comparing bytes. */
function storedHeadBase64(objectPath: string): string {
	if (BACKEND === 'local')
		return compose([
			'exec',
			'web',
			'node',
			'-p',
			'require("fs").readFileSync(process.argv[1]).subarray(0, 32).toString("base64")',
			`/data/files/${objectPath}`
		]).trim();
	return compose([
		'exec',
		'seaweedfs',
		'sh',
		'-c',
		`wget -q -O - 'http://127.0.0.1:8888/buckets/${BUCKET}/${objectPath}' | head -c 32 | base64`
	]).trim();
}

// SELFHOST_FILES_KIND picks the test in selfhost-files.config.ts: `text` (the default) drops a text file,
// `image` drops a PNG. The image test needs a model that reads images, which the local profile's small
// GGUF does not, so the workflow runs it on the `hosted` job, whose model the routing catalog marks as
// reading images.

// A 32x32 red PNG, made with zlib and nothing else.
const RED_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mO4YGBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULADxQwD12ZGFVAAAAAElFTkSuQmCC';

test(`a signed-in person adds an image to a chat with .env.example's upload settings, and finds it in My files on the stack's ${BACKEND ?? 'unset'} store`, async ({
	browser
}) => {
	test.setTimeout(240_000);
	expect(['local', 's3'], 'SELFHOST_FILES_BACKEND names the store under test').toContain(BACKEND);

	const context = await browser.newContext({
		baseURL: base,
		viewport: { width: 1280, height: 900 }
	});
	try {
		const email = `selfhost-image-${BACKEND}-${randomUUID()}@example.org`;
		await signInByEmailCode(context.request, base, email);
		const page = await context.newPage();
		await dismissWelcome(page);

		const flags = (await (await page.request.get('/chat/api/v2/feature-flags')).json()).json;
		expect(
			{ attachments: flags?.attachmentsEnabled, uploads: flags?.imageInputEnabled },
			'with .env from .env.example, the stack offers attachments and takes uploads'
		).toEqual({ attachments: true, uploads: true });

		await page.goto('/', { waitUntil: 'domcontentloaded' });
		const composer = page.getByRole('textbox', { name: /^Message/ }).first();
		await composer.click({ timeout: 60_000 });

		const name = `red-square-${BACKEND}.png`;
		await expect(async () => {
			const dataTransfer = await page.evaluateHandle(
				({ fileName, b64 }) => {
					const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
					const dt = new DataTransfer();
					dt.items.add(new File([bytes], fileName, { type: 'image/png' }));
					return dt;
				},
				{ fileName: name, b64: RED_PNG_BASE64 }
			);
			await page
				.getByRole('form', { name: 'file dropzone' })
				.dispatchEvent('dragenter', { dataTransfer });
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone).toBeVisible({ timeout: 5_000 });
			await dropzone.dispatchEvent('drop', { dataTransfer });
			// The composer shows the photo as a thumbnail named after the file, not a refusal line.
			await expect(page.getByAltText(name).or(page.getByText(name)).first()).toBeVisible({
				timeout: 5_000
			});
		}, 'the dropped image shows as attached in the composer').toPass({ timeout: 60_000 });

		await composer.fill('What colour is this square?');
		const posted = page.waitForResponse(
			(r) =>
				r.request().method() === 'POST' &&
				/\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
			{ timeout: 60_000 }
		);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
		const conversationId = new URL(page.url()).pathname.split('/').pop()!;
		const res = await posted;
		expect(res.ok(), `the message POST answered ${res.status()}`).toBe(true);

		// An image may be stored under a re-encoded name, so match on the stem.
		const stem = name.replace(/\.png$/, '');
		let stored: string | undefined;
		await expect(async () => {
			const listed = await page.request.get('/chat/api/storage');
			expect(listed.status(), 'My files lists this account').toBe(200);
			const paths = ((await listed.json()) as { files: { path: string }[] }).files.map(
				(f) => f.path
			);
			stored = paths.find((p) => p.split('/').pop()!.startsWith(stem));
			expect(stored, `${name} in My files (listed: ${JSON.stringify(paths)})`).toBeTruthy();
		}).toPass({ timeout: 120_000 });
		expect(stored, 'the image is filed under the conversation that used it').toContain(
			`/conversations/${conversationId}/`
		);
		await page.screenshot({
			path: test.info().outputPath(`image-chat-${BACKEND}.png`),
			fullPage: true
		});

		// The store holds an image (PNG, JPEG or WebP magic) or an age file when sealing is on.
		const head = Buffer.from(storedHeadBase64(stored!), 'base64');
		const kind = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
			? 'png'
			: head[0] === 0xff && head[1] === 0xd8
				? 'jpeg'
				: head.subarray(8, 12).toString('latin1') === 'WEBP'
					? 'webp'
					: head.toString('latin1').startsWith('age-encryption.org/v1')
						? 'sealed'
						: 'unknown';
		expect(kind, `the ${BACKEND} store holds ${stored} as an image or sealed`).not.toBe('unknown');
		console.log(
			`SELFHOST IMAGE PASS ${BACKEND}: ${stored} attached in chat, listed in My files, stored as ${kind}`
		);
	} finally {
		await context.close();
	}
});

test(`a signed-in person attaches a file in chat and finds it in My files, kept on the stack's ${BACKEND ?? 'unset'} store with no Hugging Face token`, async ({
	browser
}) => {
	test.setTimeout(240_000);
	expect(['local', 's3'], 'SELFHOST_FILES_BACKEND names the store under test').toContain(BACKEND);

	// The web image has no shell (distroless), so Node reads its environment.
	const configured = compose([
		'exec',
		'web',
		'node',
		'-p',
		'const e = process.env; `backend=${e.CUSTODIAL_STORAGE_BACKEND ?? ""} hf_token_chars=${(e.HF_BUCKETS_TOKEN ?? "").length} hf_repo_chars=${(e.HF_BUCKETS_REPO ?? "").length}`'
	]).trim();
	console.log(`web container: ${configured}`);
	expect(
		configured,
		'the web container runs the backend under test with no Hugging Face bucket'
	).toBe(`backend=${BACKEND} hf_token_chars=0 hf_repo_chars=0`);

	const context = await browser.newContext({
		baseURL: base,
		viewport: { width: 1280, height: 900 }
	});
	try {
		const email = `selfhost-files-${BACKEND}-${randomUUID()}@example.org`;
		await signInByEmailCode(context.request, base, email);
		const page = await context.newPage();
		await dismissWelcome(page);

		// The layout's own answers: the attach control is offered (a scan decision is made) and uploads
		// are on (the `multimodal` flag's self-host default).
		const flags = (await (await page.request.get('/chat/api/v2/feature-flags')).json()).json;
		expect(
			{ attachments: flags?.attachmentsEnabled, uploads: flags?.imageInputEnabled },
			'with .env from .env.example, the stack offers attachments and takes uploads'
		).toEqual({ attachments: true, uploads: true });

		await page.goto('/', { waitUntil: 'domcontentloaded' });
		// The label is the product name ("Message AI Potluck"); a self-host build may rename it.
		const composer = page.getByRole('textbox', { name: /^Message/ }).first();
		await composer.click({ timeout: 60_000 });

		// Dropped, the way a person attaches today (custodial-storage.spec.ts, dropRotaOnComposer).
		const name = `pantry-${BACKEND}.txt`;
		const body = `Pantry list ${randomUUID()}\nSaturday: bake the bread\n`;
		await expect(async () => {
			const dataTransfer = await page.evaluateHandle(
				({ fileName, text }) => {
					const dt = new DataTransfer();
					dt.items.add(new File([text], fileName, { type: 'text/plain' }));
					return dt;
				},
				{ fileName: name, text: body }
			);
			await page.getByRole('form', { name: 'file dropzone' }).dispatchEvent('dragenter', {
				dataTransfer
			});
			const dropzone = page.getByText('Drop files to attach');
			await expect(dropzone).toBeVisible({ timeout: 5_000 });
			await dropzone.dispatchEvent('drop', { dataTransfer });
			await expect(page.getByText(name).first()).toBeVisible({ timeout: 5_000 });
		}, 'the dropped file shows as attached in the composer').toPass({ timeout: 60_000 });

		await composer.fill('What is on the pantry list for Saturday?');
		const posted = page.waitForResponse(
			(r) =>
				r.request().method() === 'POST' &&
				/\/conversation\/[a-f0-9]+$/.test(new URL(r.url()).pathname),
			{ timeout: 60_000 }
		);
		await composer.press('Enter');
		await page.waitForURL(/\/conversation\/[a-f0-9]+/, { timeout: 60_000 });
		const conversationId = new URL(page.url()).pathname.split('/').pop()!;
		const res = await posted;
		expect(res.ok(), `the message POST answered ${res.status()}`).toBe(true);

		// The attachment is written before generation starts; a CPU model's answer is not waited for.
		let stored: string | undefined;
		await expect(async () => {
			const listed = await page.request.get('/chat/api/storage');
			expect(listed.status(), 'My files lists this account').toBe(200);
			const paths = ((await listed.json()) as { files: { path: string }[] }).files.map(
				(f) => f.path
			);
			stored = paths.find((p) => p.endsWith(`/${name}`));
			expect(stored, `${name} in My files (listed: ${JSON.stringify(paths)})`).toBeTruthy();
		}).toPass({ timeout: 120_000 });
		expect(stored, 'the attachment is filed under the conversation that used it').toContain(
			`/conversations/${conversationId}/`
		);

		await page.goto('/storage', { waitUntil: 'domcontentloaded' });
		await expect(page.getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({
			timeout: 30_000
		});
		await expect(
			page.getByRole('button', { name: `Delete ${name}` }),
			'the My files page shows the file attached in chat'
		).toBeVisible({ timeout: 30_000 });
		await page.screenshot({
			path: test.info().outputPath(`my-files-${BACKEND}.png`),
			fullPage: true
		});

		// The store itself holds it: the plaintext, or an age file when the operator turned sealing on.
		const raw = storedBytes(stored!);
		const sealed = raw.startsWith('age-encryption.org/v1');
		if (EXPECT_SEALED) {
			expect(
				sealed,
				`with sealing on in .env, the ${BACKEND} store holds ${stored} as an age file`
			).toBe(true);
			expect(raw.includes(body.split('\n')[0]), 'the stored bytes do not carry the plaintext').toBe(
				false
			);
		} else {
			expect(
				sealed || raw === body,
				`the ${BACKEND} store holds ${stored}, as written or sealed`
			).toBe(true);
		}
		console.log(
			`SELFHOST FILES PASS ${BACKEND}: ${stored} listed in My files and read from the ${BACKEND} store (${raw.length} bytes, ${sealed ? 'sealed' : 'plaintext'})`
		);
	} finally {
		await context.close();
	}
});
