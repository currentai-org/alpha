import { dev } from '$app/environment';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PageServerLoad } from './$types';
import { parseGeneratedSamples } from '$lib/chat/evaluate/generated';
import { error } from '@sveltejs/kit';
import { humanEvalEnabled } from '$lib/chat/server/humanEval/gate';

/**
 * The page is behind the same `human-eval` flag as the API it calls (CUR-1914), so it never shows
 * where rating can't be saved. Local generation output is a preview for `?sample=1` in development;
 * the API owns scored answers everywhere else.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!humanEvalEnabled()) throw error(404, 'Not found');
	const signedIn = !!locals.user;
	if (!dev) return { signedIn, generatedSamples: null };
	try {
		const text = await readFile(resolve('evals/results/human-evaluation/samples.json'), 'utf8');
		return { signedIn, generatedSamples: parseGeneratedSamples(JSON.parse(text)) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { signedIn, generatedSamples: null };
		throw err;
	}
};
