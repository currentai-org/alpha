import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_IDLE_MS, RemoteReadError, RemoteReader, isNearDraft } from './remoteRead';

/** A read whose resolution the test controls. */
function controlledRead() {
	const calls: { text: string; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
	const read = vi.fn(
		(text: string) =>
			new Promise<string>((resolve, reject) => {
				calls.push({ text, resolve, reject });
			})
	);
	return { read, calls };
}

/** Type `text` one character at a time, `gap` ms apart. */
function type(reader: RemoteReader<string>, text: string, gap = 80) {
	for (let i = 1; i <= text.length; i++) {
		reader.want(text.slice(0, i));
		vi.advanceTimersByTime(gap);
	}
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('RemoteReader: asking the hosted classifier sparingly', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('sends nothing while typing continues, then one read after the pause', () => {
		const { read } = controlledRead();
		const r = new RemoteReader({ read });
		type(r, 'Pourquoi le ciel est-il bleu ? Explique-moi simplement.');
		expect(read).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0][0]).toBe('Pourquoi le ciel est-il bleu ? Explique-moi simplement.');
	});

	it('keeps the default pause when options are passed as undefined, as the composer does', () => {
		const { read } = controlledRead();
		const r = new RemoteReader({ read, idleMs: undefined, minChars: undefined });
		type(r, 'Hui vull eixir prompte amb els xiquets', 110);
		expect(read).not.toHaveBeenCalled();
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('never sends a draft under the minimum length', () => {
		const { read } = controlledRead();
		const r = new RemoteReader({ read });
		r.want('hola que');
		vi.advanceTimersByTime(REMOTE_IDLE_MS * 3);
		expect(read).not.toHaveBeenCalled();
	});

	it('keeps one read in flight: drafts typed meanwhile collapse into one follow-up with the newest text', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		r.want('Write a Rust function');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(r.inFlight).toBe(true);

		for (const draft of [
			'Write a Rust function that parses timestamps',
			'Write a Rust function that parses RFC 3339 timestamps and handles leap seconds',
			'Write a Rust function that parses RFC 3339 timestamps and handles leap seconds, with tests'
		]) {
			r.want(draft);
			vi.advanceTimersByTime(REMOTE_IDLE_MS);
		}
		expect(read).toHaveBeenCalledTimes(1);

		calls[0].resolve('first');
		await flush();
		expect(read).toHaveBeenCalledTimes(2);
		expect(calls[1].text).toBe('Write a Rust function that parses RFC 3339 timestamps and handles leap seconds, with tests');
	});

	it('reuses a read for a small edit instead of asking again', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		const draft = 'What is the latest news on the Swiss election results';
		r.want(draft);
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		calls[0].resolve('news');
		await flush();

		r.want(`${draft} today?`);
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(1);
		expect(r.readFor(`${draft} today?`)).toBe('news');
		// A different message is not a small edit.
		expect(r.readFor('Hoe laat is het in Amsterdam?')).toBeUndefined();
	});

	it('does not ask about a small edit made while the previous read was still out', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		r.want("Tu peux m'aider");
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		r.want("Tu peux m'aider?");
		vi.advanceTimersByTime(200);
		calls[0].resolve('fra');
		await flush();
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(1);
		expect(r.readFor("Tu peux m'aider?")).toBe('fra');
	});

	it('answers an exact earlier draft from its cache after the person deletes back to it', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		r.want('Translate this into German please');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		calls[0].resolve('one');
		await flush();
		r.want('Summarise the history of the Swiss confederation in five points');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		calls[1].resolve('two');
		await flush();

		r.want('Translate this into German please');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(2);
		expect(r.readFor('Translate this  into German please ')).toBe('one');
	});

	it('stops for good on a 404 (the feature is off for this person)', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		r.want('Explain quantum entanglement simply');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		calls[0].reject(new RemoteReadError(404));
		await flush();
		r.want('Something else entirely to classify');
		vi.advanceTimersByTime(REMOTE_IDLE_MS * 100);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('pauses for a minute on a 429, then asks again', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		r.want('Explain quantum entanglement simply');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		calls[0].reject(new RemoteReadError(429));
		await flush();

		r.want('Explain quantum entanglement simply please');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		r.want('Explain quantum entanglement simply please');
		vi.advanceTimersByTime(REMOTE_IDLE_MS);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('pauses after three failures in a row', async () => {
		const { read, calls } = controlledRead();
		const r = new RemoteReader({ read });
		const drafts = ['Explain photosynthesis to me', 'Why do cats purr when happy', 'How do vaccines train immunity', 'What causes the northern lights'];
		for (const [i, d] of drafts.entries()) {
			r.want(d);
			vi.advanceTimersByTime(REMOTE_IDLE_MS);
			calls[i]?.reject(new RemoteReadError(502));
			await flush();
		}
		expect(read).toHaveBeenCalledTimes(3);
	});
});

describe('isNearDraft', () => {
	it('treats a typo fix or an added word as the same draft, and a rewrite as a new one', () => {
		const a = 'Can you summarise the attached report on renewable energy policy';
		expect(isNearDraft(a, `${a} for me`)).toBe(true);
		expect(isNearDraft(a, a.replace('policy', 'polcy'))).toBe(true);
		expect(isNearDraft('Write a Rust function', 'Write a Rust function that parses RFC 3339 timestamps')).toBe(false);
		expect(isNearDraft(a, 'Peux-tu résumer le rapport ci-joint sur la politique énergétique')).toBe(false);
	});
});
