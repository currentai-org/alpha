// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Message } from "$lib/chat/types/Message";

export function isMessageId(id: string): id is Message["id"] {
	return id.split("-").length === 5;
}
