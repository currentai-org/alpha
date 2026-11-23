// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
declare module '*.ttf' {
	const value: ArrayBuffer;
	export default value;
}

// Web search shapes are deliberately not declared in the global ambient types.

// SvelteKit 3 still serves these deprecated `$env/*` modules at runtime but ships no types for them
// (its typed replacements are `$app/env/public` and `$app/env/private`, which export one binding per
// declared variable and so cannot back the dynamic `env[name]` lookups in `$lib/chat/server/config.ts`).
declare module '$env/dynamic/private' {
	export const env: Record<string, string>;
}
declare module '$env/dynamic/public' {
	export const env: Record<string, string>;
}
declare module '$env/static/public' {
	export const PUBLIC_COMMIT_SHA: string | undefined;
}
