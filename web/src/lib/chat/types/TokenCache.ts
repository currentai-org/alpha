// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Timestamps } from "./Timestamps";

export interface TokenCache extends Timestamps {
	tokenHash: string; // sha256 of the bearer token
	userId: string; // the matching hf user id
}
