// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
const MAX_PARAM_LENGTH = 10_000;

export function sanitizeUrlParam(value: string | null): string | null {
	if (value == null) return null;

	const trimmed = value.trim();
	if (!trimmed.length) return null;
	if (trimmed.length > MAX_PARAM_LENGTH) return null;

	return trimmed;
}

export { MAX_PARAM_LENGTH };
