// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
export async function getReturnFromGenerator<T, R>(generator: AsyncGenerator<T, R>): Promise<R> {
	let result: IteratorResult<T, R>;
	do {
		result = await generator.next();
	} while (!result.done); // Keep calling `next()` until `done` is true
	return result.value; // Return the final value
}
