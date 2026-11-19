// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
export const timeout = <T>(prom: Promise<T>, time: number): Promise<T> => {
	let timer: NodeJS.Timeout;
	return Promise.race([
		prom,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timeout after ${time / 1000} seconds`)), time);
		}),
	]).finally(() => clearTimeout(timer));
};
