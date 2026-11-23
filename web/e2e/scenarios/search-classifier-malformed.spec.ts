// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { faultInjectionHeaders } from './helpers/faultInjection';

// A search-need classifier reply that is neither yes nor no decides "no", exactly like a real no, so
// the decision log has to say which it was or a garbled reply silently skips web search.
// `search_classifier_malformed` makes the classifier's reply garbage, and makes the completion
// classifier decide even where the embedding gate otherwise would (preview runs `margin`). The search
// decision probe runs the same decideWebSearch a chat turn does and answers with what its
// `[search] decision` line logs, so this reads the decision a turn would log.
// @preview-only: the fault header is honoured only off production.

const QUESTION = 'What is the capital of Switzerland?';

type Decision = {
	shouldSearch: boolean;
	decider: string;
	fallback?: string;
	classifierReading?: string;
	ok: boolean;
};

test(
	'a classifier reply that is neither yes nor no is logged as malformed on the search decision, apart from a real verdict',
	{ tag: ['@preview-only'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		// The probe needs a session, which the first visit to chat mints.
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		const url = `/chat/api/search/classify?q=${encodeURIComponent(QUESTION)}`;

		const faulted = await page.request.get(url, {
			headers: faultInjectionHeaders('search_classifier_malformed')
		});
		expect(faulted.ok(), `the search decision probe answered ${faulted.status()}`).toBe(true);
		const malformed = (await faulted.json()) as Decision;
		expect(
			malformed,
			'the fault did not reach the server, or the decision does not say the reply was malformed'
		).toMatchObject({
			decider: 'completion',
			classifierReading: 'malformed',
			ok: true,
			shouldSearch: false
		});
		expect(malformed.fallback, 'a malformed reply was counted as a failed call').toBeUndefined();

		// The same question with no fault: whatever decides it, its decision never reads malformed, so
		// the reading above is the fault's and not every decision's.
		const healthy = await page.request.get(url);
		expect(healthy.ok(), `the search decision probe answered ${healthy.status()}`).toBe(true);
		const real = (await healthy.json()) as Decision;
		expect(real.classifierReading, 'a decision with no fault read as malformed').not.toBe(
			'malformed'
		);
	}
);
