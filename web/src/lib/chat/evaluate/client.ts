import { base } from '$lib/chat/paths';
import type { EvalLanguage, LanguageResults, NextItem, ProfileSubmission, RatingRefusal, RatingResult, RatingSubmission } from './types';

/**
 * The evaluation page's calls to the human evaluation API. A failure the page has to explain is
 * thrown as an `EvalApiError` with its kind; a refused rating is a value, since the page shows
 * which questions are missing.
 */
export interface EvalApi {
	/** True for the sample-data stand-in (fixtures.ts), so the page can say so. */
	readonly sample: boolean;
	languages(): Promise<EvalLanguage[]>;
	next(language: string): Promise<NextItem>;
	saveProfile(body: ProfileSubmission): Promise<void>;
	rate(body: RatingSubmission): Promise<RatingResult>;
	/** How each model does in a language so far. Open to signed-out visitors. */
	results(language: string): Promise<LanguageResults>;
}

export type EvalApiErrorKind =
	/** 401: the session ended; sign in again. */
	| 'signed_out'
	/** 404 from the languages route: the API is off (flag) or not deployed here. */
	| 'unavailable'
	/** 404 from the profile route: this language isn't open. */
	| 'closed'
	/** fetch itself failed: offline, DNS, a dropped connection. */
	| 'network'
	| 'error';

export class EvalApiError extends Error {
	constructor(
		readonly kind: EvalApiErrorKind,
		message: string
	) {
		super(message);
	}
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${base}/api/eval/${path}`, init);
	} catch (err) {
		throw new EvalApiError('network', String(err));
	}
	if (res.status === 401) throw new EvalApiError('signed_out', 'Sign in to evaluate.');
	return res;
}

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body)
});

export const httpEvalApi: EvalApi = {
	sample: false,

	async languages() {
		const res = await call('languages');
		if (res.status === 404) throw new EvalApiError('unavailable', 'Evaluation is not open here.');
		if (!res.ok) throw new EvalApiError('error', `languages: ${res.status}`);
		return ((await res.json()) as { languages: EvalLanguage[] }).languages;
	},

	async next(language) {
		const res = await call(`next?language=${encodeURIComponent(language)}`);
		if (res.status === 404) throw new EvalApiError('unavailable', 'Evaluation is not open here.');
		if (!res.ok) throw new EvalApiError('error', `next: ${res.status}`);
		return (await res.json()) as NextItem;
	},

	async saveProfile(body) {
		const res = await call('profile', json(body));
		if (res.status === 404) throw new EvalApiError('closed', 'This language is not open for evaluation yet.');
		if (!res.ok) throw new EvalApiError('error', `profile: ${res.status}`);
	},

	async rate(body) {
		const res = await call('ratings', json(body));
		if (res.ok) return { ok: true };
		const refusal = (await res.json().catch(() => null)) as RatingRefusal | null;
		if (refusal && refusal.ok === false && refusal.reason) {
			return { ok: false, reason: refusal.reason, missing: refusal.missing ?? [], invalid: refusal.invalid ?? [] };
		}
		throw new EvalApiError('error', `ratings: ${res.status}`);
	},

	async results(language) {
		const res = await call(`results?language=${encodeURIComponent(language)}`);
		if (res.status === 404) throw new EvalApiError('unavailable', 'Evaluation is not open here.');
		if (!res.ok) throw new EvalApiError('error', `results: ${res.status}`);
		return (await res.json()) as LanguageResults;
	}
};
