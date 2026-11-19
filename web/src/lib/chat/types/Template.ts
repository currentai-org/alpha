// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Message } from "./Message";

export type ChatTemplateInput = {
	messages: Pick<Message, "from" | "content" | "files">[];
	preprompt?: string;
};
