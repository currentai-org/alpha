// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
// Is MCP elicitation on? Gates whether the client advertises the `elicitation`
// capability at all — nothing about it can fire while this is off, since a server never sees the
// capability to use it.
//
// A NEW flag, not a reuse of `mcp-servers`: a bug in this path shouldn't force disabling MCP
// entirely to contain it. Fallback is OFF — a gated feature defaults closed, and there is currently
// no live MCP server that would ever exercise this (the one configured Space is TTS-only).

import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. */
export const MCP_ELICITATION_FLAG = "mcp-elicitation";

/** Should the MCP client advertise (and act on) the elicitation capability? Sync, never throws. */
export function elicitationEnabled(): boolean {
	return flagEnabledOr(MCP_ELICITATION_FLAG, () => false);
}
