// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
type Gen<T, TReturn> = AsyncGenerator<T, TReturn, undefined>;

type GenPromiseMap<T, TReturn> = Map<
	Gen<T, TReturn>,
	Promise<{ gen: Gen<T, TReturn> } & IteratorResult<T, TReturn>>
>;

/** Merges multiple async generators into a single async generator that yields values from all of them in parallel. */
export async function* mergeAsyncGenerators<T, TReturn>(
	generators: Gen<T, TReturn>[]
): Gen<T, TReturn[]> {
	const promises: GenPromiseMap<T, TReturn> = new Map();
	const results: Map<Gen<T, TReturn>, TReturn> = new Map();

	for (const gen of generators) {
		promises.set(
			gen,
			gen.next().then((result) => ({ gen, ...result }))
		);
	}

	try {
		while (promises.size) {
			const { gen, value, done } = await Promise.race(promises.values());
			if (done) {
				results.set(gen, value as TReturn);
				promises.delete(gen);
			} else {
				promises.set(
					gen,
					gen.next().then((result) => ({ gen, ...result }))
				);
				yield value as T;
			}
		}
	} finally {
		// A reader that stops early (the loop cut, a closed request) must close every source still running.
		// Left open, the answer's source keeps the model's HTTP stream open, and the provider writes to its
		// token cap for nobody. Each return runs after that source's pending next settles; it is
		// not awaited, so a source waiting on a timer cannot hold up the reader.
		for (const [gen, pending] of promises) {
			pending.catch(() => {});
			gen.return(undefined as TReturn).catch(() => {});
		}
	}

	const orderedResults = generators.map((gen) => results.get(gen) as TReturn);
	return orderedResults;
}
