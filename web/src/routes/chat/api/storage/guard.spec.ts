import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '$lib/chat/server/logger';
import { HmaUnreachableError } from '$lib/chat/server/storage/csamScan';
import { ImageScreenUnavailableError, TooManyImagesToScreenError } from '$lib/chat/server/storage/uploadImageGuard';
import { UnscannableFileError } from '$lib/chat/server/storage/embeddedImageScan';
import { FileTooLargeError } from '$lib/chat/server/storage/custodialStorage';
import { storageFailure } from './guard';

// storageFailure maps the error to an HTTP error and throws it; the log line is what is under test.
function refuse(e: unknown): void {
	try {
		storageFailure(e);
	} catch {
		// the mapped HTTP error, or the rethrown original
	}
}

afterEach(() => vi.restoreAllMocks());

describe('storageFailure logs the refusing check (CUR-4658)', () => {
	it.each([
		['csam-hash', new HmaUnreachableError('HTTP 502'), 'HTTP 502'],
		['image-screen', new ImageScreenUnavailableError('no answer from the screen'), 'no answer from the screen'],
		['embedded-images', new UnscannableFileError('pdf did not open'), 'pdf did not open'],
		['image-screen-count', new TooManyImagesToScreenError(31), '31']
	])('names the %s check and its reason, so a refused upload can be traced to the check that refused it', (check, err, reason) => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		refuse(err);
		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, msg] = warn.mock.calls[0] as unknown as [{ check: string; reason: string }, string];
		expect(msg).toBe('[upload-guard] upload refused');
		expect(fields.check).toBe(check);
		expect(fields.reason).toContain(reason);
	});

	it('logs nothing for an error that is not a scan refusal', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		refuse(new FileTooLargeError(10, 5));
		refuse(new Error('unrelated'));
		expect(warn).not.toHaveBeenCalled();
	});
});
