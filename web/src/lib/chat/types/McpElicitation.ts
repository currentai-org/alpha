// A parked mid-tool-call question from an MCP server (CUR-1017), 2026-era ("input_required") only.
// Ported from huggingface/chat-ui's McpElicitation.ts, trimmed to what a 2026-only flow needs: no
// `expiresAt` (that bounds the 2025-era BLOCKING flow this repo doesn't support — see
// schema.ts's mcpElicitations comment for why), no ask_user_question-specific PendingCall variants
// or budget-grant fields (that's a later, separate slice).
import type { Conversation } from "./Conversation";
import type { Timestamps } from "./Timestamps";

/** Normalized from MCP's `PrimitiveSchemaDefinition`, which spells a select box several ways. */
export type ElicitationField =
	| {
			kind: "string";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			minLength?: number;
			maxLength?: number;
			format?: "email" | "uri" | "date" | "date-time";
			default?: string;
	  }
	| {
			kind: "number";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			integer: boolean;
			minimum?: number;
			maximum?: number;
			default?: number;
	  }
	| {
			kind: "boolean";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			default?: boolean;
	  }
	| {
			kind: "select";
			name: string;
			title?: string;
			description?: string;
			required: boolean;
			multiple: boolean;
			options: Array<{ value: string; label: string }>;
			minItems?: number;
			maxItems?: number;
			default?: string | string[];
	  };

export type ElicitationValue = string | number | boolean | string[];

export type ElicitationAction = "accept" | "decline" | "cancel";

/** Every string here is server-authored, so it is display text and never markup. */
export interface ElicitationRequestPayload {
	server: string;
	mode: "form" | "url";
	message: string;
	fields?: ElicitationField[];
	url?: string;
}

/** What re-issues the original tool call once answered — a fresh, independent turn does the
 *  re-issue, so this must be self-contained rather than relying on any in-memory turn state. */
export interface PendingMcpCall {
	server: string;
	tool: string;
	args: Record<string, unknown>;
	/** Opaque; echoed back byte-exact to the server on resume. */
	requestState?: string;
	/** Which key in the server's inputRequests this answer is for. */
	inputKey: string;
}

/** In the database because the pod serving the answer need not be the one that parked it. */
export interface McpElicitation extends Timestamps {
	conversationId: Conversation["_id"];
	status: "pending" | "resolved";
	request: ElicitationRequestPayload;
	action?: ElicitationAction;
	content?: Record<string, ElicitationValue>;
	resolvedAt?: Date;
	pending: PendingMcpCall;
}
