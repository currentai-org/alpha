// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
// The /chat subtree is fully dynamic (auth, DB, streaming) — never prerender it; keep SSR on.
export const prerender = false;
export const ssr = true;
