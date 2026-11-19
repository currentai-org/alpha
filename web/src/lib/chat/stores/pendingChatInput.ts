// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { writable } from "svelte/store";

export const pendingChatInput = writable<string | undefined>(undefined);
