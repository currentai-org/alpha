// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Timestamps } from "./Timestamps";

export interface Semaphore extends Timestamps {
	key: string;
	deleteAt: Date;
}

export enum Semaphores {
	CONVERSATION_STATS = "conversation.stats",
	CONFIG_UPDATE = "config.update",
	MIGRATION = "migration",
	TEST_MIGRATION = "test.migration",
	/**
	 * Note this lock name is used as `${Semaphores.OAUTH_TOKEN_REFRESH}:${sessionId}`
	 *
	 * not a global lock, but a lock for each session
	 */
	OAUTH_TOKEN_REFRESH = "oauth.token.refresh",
}
