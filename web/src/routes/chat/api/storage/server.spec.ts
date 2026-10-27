import { beforeEach, describe, expect, it, vi } from 'vitest';

// The storage module's FUNCTIONS are stubbed; its typed error classes are not. guard.ts decides a
// status with `instanceof`, so a fully-mocked module would make every one of those checks fall
// through to a rethrow and the limit tests below would pass for the wrong reason — they would be
// asserting that an error escaped, not that it was mapped.
const { listCustodialFiles, uploadCustodialFile } = vi.hoisted(() => ({
	listCustodialFiles: vi.fn(),
	uploadCustodialFile: vi.fn()
}));
const { custodialStorageViewEnabledForUser } = vi.hoisted(() => ({
	custodialStorageViewEnabledForUser: vi.fn()
}));

vi.mock('$lib/chat/server/storage/custodialStorage', async (importOriginal) => ({
	...(await importOriginal<object>()),
	listCustodialFiles,
	uploadCustodialFile
}));
vi.mock('$lib/chat/server/storage/custodialStorageGate', () => ({
	CUSTODIAL_STORAGE_VIEW_FLAG: 'custodial-storage-view',
	custodialStorageViewEnabledForUser
}));

import {
	FileTooLargeError,
	StorageQuotaExceededError,
	UnsupportedFileTypeError,
	UploadRateLimitedError
} from '$lib/chat/server/storage/custodialStorage';

import { CsamScannerUnconfiguredError, HmaUnreachableError } from '$lib/chat/server/storage/csamScan';
import { HubApiError } from '@huggingface/hub';
import { STORAGE_BUSY_MESSAGE } from '$lib/chat/constants/custodialUpload';
import { logger } from '$lib/chat/server/logger';

import { GET, POST } from './+server';

// 24 hex, the shape locals.user._id carries. Invented.
const ACCOUNT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function locals(signedIn = true) {
	return signedIn ? { user: { _id: { toString: () => ACCOUNT_ID } } } : {};
}

function upload(folder = 'documents', name = 'notes.txt'): Request {
	const form = new FormData();
	form.set('file', new File([new Uint8Array([1, 2, 3])], name));
	form.set('folder', folder);
	return new Request('http://localhost/chat/api/storage', { method: 'POST', body: form });
}

beforeEach(() => {
	vi.clearAllMocks();
	custodialStorageViewEnabledForUser.mockResolvedValue(true);
	listCustodialFiles.mockResolvedValue([]);
	uploadCustodialFile.mockResolvedValue(undefined);
});

describe('storage route access control', () => {
	it('refuses an anonymous caller with 401 and never reaches the bucket', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(false), url: new URL("https://alpha.test/chat/api/storage") })).rejects.toMatchObject({ status: 401 });
		expect(listCustodialFiles).not.toHaveBeenCalled();
	});

	it('answers 404, NOT 403, when the flag is off for this person — a dark feature must look absent', async () => {
		custodialStorageViewEnabledForUser.mockResolvedValue(false);
		// 403 would confirm the surface exists and invite someone back for it once it ships.
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: locals(), url: new URL("https://alpha.test/chat/api/storage") })).rejects.toMatchObject({ status: 404 });
		expect(listCustodialFiles).not.toHaveBeenCalled();
	});

	it('gates on the ACCOUNT id, so the flag answers a question about a person', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await GET({ locals: locals(), url: new URL("https://alpha.test/chat/api/storage") });
		expect(custodialStorageViewEnabledForUser).toHaveBeenCalledWith(ACCOUNT_ID);
	});

	it('passes only locals.user._id to the storage module, never anything off the request', async () => {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await POST({ locals: locals(), request: upload() });
		expect(uploadCustodialFile).toHaveBeenCalledWith(ACCOUNT_ID, 'documents/notes.txt', expect.any(File), {
			scannerDown: false,
			imagesAllowed: false,
			documentsAllowed: false
		});
	});

	it('ignores a scanner-down fault header that carries no valid token, so a caller cannot choose the fault (CUR-2382)', async () => {
		const request = upload();
		request.headers.set('x-e2e-fault-inject', 'csam_scanner_down');
		request.headers.set('x-e2e-fault-inject-token', 'not-the-token');
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await POST({ locals: locals(), request });
		expect(uploadCustodialFile).toHaveBeenCalledWith(ACCOUNT_ID, 'documents/notes.txt', expect.any(File), {
			scannerDown: false,
			imagesAllowed: false,
			documentsAllowed: false
		});
	});
});

describe('the CUR-1129 limits are enforced FROM THE ROUTE, not only in a unit test', () => {
	it('turns an oversize file into 413 rather than letting it through', async () => {
		uploadCustodialFile.mockRejectedValue(new FileTooLargeError(9_000_000));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toMatchObject({ status: 413 });
	});

	it('turns an unsupported type into 415 — the sniffed type, not the extension', async () => {
		uploadCustodialFile.mockRejectedValue(new UnsupportedFileTypeError('application/x-dosexec'));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toMatchObject({ status: 415 });
	});

	it('turns a full account into 507, not 413 — a client retrying smaller would spin forever', async () => {
		uploadCustodialFile.mockRejectedValue(new StorageQuotaExceededError(250_000_000, 200));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toMatchObject({ status: 507 });
	});

	it('turns a rate-limited upload into 429 AND says how long to wait', async () => {
		uploadCustodialFile.mockRejectedValue(new UploadRateLimitedError(4_200));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res = await POST({ locals: locals(), request: upload() });
		expect(res.status).toBe(429);
		// Rounded up: a Retry-After of 4 would invite a retry that is still rate-limited.
		expect(res.headers.get('retry-after')).toBe('5');
	});
});

describe('an upload that could not be scanned (CUR-2382)', () => {
	it('refuses with 503 AND logs at error when no scanner is configured, since that is a config error', async () => {
		const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
		uploadCustodialFile.mockRejectedValue(new CsamScannerUnconfiguredError());
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toMatchObject({ status: 503 });
		expect(logged).toHaveBeenCalledWith(expect.stringContaining('CSAM_SCAN_BASE_URL is unset'));
	});

	it('refuses with 503 and no config-error line when a configured scanner did not answer', async () => {
		const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
		uploadCustodialFile.mockRejectedValue(new HmaUnreachableError(new Error('timeout')));
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toMatchObject({ status: 503 });
		expect(logged).not.toHaveBeenCalled();
	});
});

describe('Hugging Face throttling the storage token (CUR-3120)', () => {
	const throttled = () => new HubApiError('https://huggingface.co/api/buckets/x', 429);

	it('answers an upload with 503, the busy line and Retry-After, not a 500', async () => {
		uploadCustodialFile.mockRejectedValue(throttled());
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res: Response = await POST({ locals: locals(), request: upload() });
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		expect(await res.json()).toEqual({ message: STORAGE_BUSY_MESSAGE });
	});

	it('lists each file with the time the bucket took it, and none of the vendor fields (CUR-3289)', async () => {
		listCustodialFiles.mockResolvedValue([
			{ path: 'users/u/conversations/c1/abc/a.png', size: 3, uploadedAt: '2026-10-08T09:00:00Z', oid: 'x', type: 'file' },
		]);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res: Response = await GET({ locals: locals(), url: new URL('https://alpha.test/chat/api/storage'), request: new Request('https://alpha.test/chat/api/storage') });
		expect(await res.json()).toEqual({
			files: [{ path: 'users/u/conversations/c1/abc/a.png', size: 3, addedAt: '2026-10-08T09:00:00Z' }],
		});
	});

	it('answers a listing with 503, the busy line and Retry-After, not a 500', async () => {
		listCustodialFiles.mockRejectedValue(throttled());
		// @ts-expect-error - RequestEvent is heavier than this test needs
		const res: Response = await GET({ locals: locals(), url: new URL('https://alpha.test/chat/api/storage'), request: new Request('https://alpha.test/chat/api/storage') });
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		expect(await res.json()).toEqual({ message: STORAGE_BUSY_MESSAGE });
	});

	it('still rethrows any other Hugging Face failure, so a real outage is not reported as busy', async () => {
		const outage = new HubApiError('https://huggingface.co/api/buckets/x', 500);
		uploadCustodialFile.mockRejectedValue(outage);
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request: upload() })).rejects.toBe(outage);
	});
});

describe('upload input', () => {
	it('rejects a folder outside the layout\'s own named set', async () => {
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			POST({ locals: locals(), request: upload('receipts') })
		).rejects.toMatchObject({ status: 400 });
		expect(uploadCustodialFile).not.toHaveBeenCalled();
	});

	it('rejects a request with no file part', async () => {
		const form = new FormData();
		form.set('folder', 'documents');
		const request = new Request('http://localhost/chat/api/storage', { method: 'POST', body: form });
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(POST({ locals: locals(), request })).rejects.toMatchObject({ status: 400 });
	});

	it('reduces the filename to a basename, so a file cannot leave its named subfolder', async () => {
		// resolveUserPath guards the ACCOUNT boundary and holds, but a `../` in the filename walks out of
		// `documents/` to somewhere still legitimately mine, which it has no reason to refuse. The basename
		// reduction is a separate contract (adversarial.spec.ts).
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await POST({ locals: locals(), request: upload('documents', '../../escape.txt') });
		expect(uploadCustodialFile).toHaveBeenCalledWith(
			ACCOUNT_ID,
			'documents/escape.txt',
			expect.any(File),
			{ scannerDown: false, imagesAllowed: false, documentsAllowed: false }
		);
	});

	it('refuses a filename with no basename left to store', async () => {
		await expect(
			// @ts-expect-error - RequestEvent is heavier than this test needs
			POST({ locals: locals(), request: upload('documents', '../..') })
		).rejects.toMatchObject({ status: 400 });
		expect(uploadCustodialFile).not.toHaveBeenCalled();
	});
});
