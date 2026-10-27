import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { BUSY_HERE_MS, busyHereAt, busyNow, refreshServerBusy, serverBusy, serverBusyNow } from './busyHere';

describe('busyHere (CUR-4043)', () => {
	it("a tab's own busy mark holds for ten minutes and then lets Auto try the model again", () => {
		const marks = new Map([['apertus-70b', 1_000 + BUSY_HERE_MS]]);
		expect(busyHereAt(marks, 1_000 + BUSY_HERE_MS - 1)).toEqual(['apertus-70b']);
		expect(busyHereAt(marks, 1_000 + BUSY_HERE_MS)).toEqual([]);
	});
});

describe('busyNow (CUR-4043)', () => {
	it("joins the server's marks with this tab's live ones, once each", () => {
		const marks = new Map([
			['apertus-70b', 2_000],
			['glm', 500]
		]);
		expect(busyNow(['apertus-70b', 'mistral-large'], marks, 1_000)).toEqual(['apertus-70b', 'mistral-large']);
	});
});

describe("an open tab's read of the server's marks (CUR-4629)", () => {
	const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

	it('a model the server marks down after the page loaded is routed around, and one it clears comes back, without a reload', async () => {
		const atLoad: string[] = [];
		await refreshServerBusy(answer({ busyModels: ['BSC-LT/ALIA-40b-instruct'] }));
		expect(busyNow(serverBusyNow(atLoad, get(serverBusy)), new Map())).toEqual(['BSC-LT/ALIA-40b-instruct']);
		await refreshServerBusy(answer({ busyModels: [] }));
		expect(busyNow(serverBusyNow(['BSC-LT/ALIA-40b-instruct'], get(serverBusy)), new Map())).toEqual([]);
	});

	it('keeps the last list when a read fails, so a lost read neither marks nor clears anything', async () => {
		await refreshServerBusy(answer({ busyModels: ['mistralai/mistral-large-2610'] }));
		await refreshServerBusy(answer({}, false));
		await refreshServerBusy((async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch);
		expect(get(serverBusy)).toEqual(['mistralai/mistral-large-2610']);
	});

	it("uses the page load's marks until the tab's first read lands", () => {
		expect(serverBusyNow(['x'], null)).toEqual(['x']);
	});
});
