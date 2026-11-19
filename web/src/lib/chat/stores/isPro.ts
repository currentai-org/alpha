// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { writable } from "svelte/store";

// null = unknown/loading, true = PRO, false = not PRO
export const isPro = writable<boolean | null>(null);
