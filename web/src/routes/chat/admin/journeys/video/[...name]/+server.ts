// Serves one walkthrough recording to the journeys page. Recordings live in the bucket
// under journey-gallery/; older runs are still read from the `files` table as a fallback.
//
// Two independent restrictions, because one of them alone would be a file-read endpoint wearing a
// journey page's name:
//
//   1. The same admin cookie the page itself is behind. Without it this is a 404, not a 401 — a 401
//      would confirm which filenames exist to someone who is not signed in.
//   2. readJourneyRecording() reads only under the bucket's journey-gallery/ prefix, never a
//      person's users/<id>/ folder, and getUnscopedFileByFilename() can only ever return a row whose
//      conversation_id IS NULL. The prefix check below narrows both again to this page's own
//      files, so even a signed-in operator cannot read someone's attachment through this path.

import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { isAdminPermitted } from '$lib/chat/server/adminAuth';
import { getUnscopedFileByFilename } from '$lib/chat/server/db/files';
import { logger } from '$lib/chat/server/logger';
import { readJourneyRecording } from '$lib/chat/server/storage/custodialStorage';
import { VIDEO_PREFIX, parseRange } from '$lib/chat/server/journeyGallery';

export const GET: RequestHandler = async ({ params, cookies, locals, request }) => {
	// 404 rather than 401: an unauthenticated caller learns nothing about what is stored here.
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) error(404, 'Not found');

	const filename = `${VIDEO_PREFIX}${params.name}`;
	if (!filename.startsWith(VIDEO_PREFIX) || filename.includes('..')) error(404, 'Not found');

	const blob = await readJourneyRecording(filename).catch((e) => {
		logger.warn(
			{ filename, err: e instanceof Error ? e.name : String(e) },
			'[journeys] bucket read failed, using the files table'
		);
		return null;
	});
	const row = blob ? null : await getUnscopedFileByFilename(filename);
	if (!blob && !row) error(404, 'Not found');

	const data = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(row!.data);
	const headers = {
		'content-type': row?.mime ?? 'video/webm',
		// Without ranges Chrome will not seek, so the tile's `#t=` start point would be ignored
		// and every tile would preview the recording's first frame, the blank tab before the page loads.
		'accept-ranges': 'bytes',
		// One run's videos are replaced wholesale by the next, and the filenames repeat, so a
		// cached copy would show the previous run's footage under the current run's card.
		'cache-control': 'no-store',
		'content-disposition': 'inline'
	};

	const range = parseRange(request.headers.get('range'), data.length);
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { ...headers, 'content-range': `bytes */${data.length}` }
		});
	}
	if (range) {
		return new Response(data.subarray(range.start, range.end + 1), {
			status: 206,
			headers: {
				...headers,
				'content-range': `bytes ${range.start}-${range.end}/${data.length}`,
				'content-length': String(range.end - range.start + 1)
			}
		});
	}
	return new Response(data, { headers: { ...headers, 'content-length': String(data.length) } });
};
