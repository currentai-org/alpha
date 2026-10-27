// Park a 2026-era MCP input_required result, and answer one later from a separate, independent
// request (CUR-1017). See db/schema.ts's mcpElicitations comment for why this repo only supports
// the stateless 2026-era flow, never the 2025-era blocking one.
//
// Unlike upstream's Mongo `_id` + a separate `elicitationId` UUID, this uses the row's own `_id`
// as the elicitation's identity — one less field, matching this repo's docStore convention
// (abortedGenerations does the same).
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger";
import { normalizeElicitationRequest, validateElicitationContent } from "./elicitationSchema";
import type {
	McpElicitation,
	ElicitationAction,
	ElicitationValue,
} from "$lib/chat/types/McpElicitation";
import type { McpCallResult } from "./client";

export type OpenElicitationResult =
	| { opened: true; elicitationId: string }
	| { opened: false; reason: string };

/** Park a 2026-era input_required result so a later, independent request can answer it and
 *  re-issue the original tool call. A real input_required batch can carry sampling/roots requests
 *  alongside (or instead of) an elicitation — this repo declares neither capability, so a
 *  well-behaved server shouldn't send them, but a misbehaving one might; pick the first entry
 *  that actually normalizes as an elicitation and drop the rest rather than guess at them.
 *  Nothing in production opens one since the single-Space path retired (CUR-3989); the answer route
 *  stays so a configured server can use it again. */
export async function openDurableElicitation(opts: {
	conversationId: ObjectId;
	server: string;
	tool: string;
	args: Record<string, unknown>;
	inputRequired: Extract<McpCallResult, { kind: "input_required" }>;
}): Promise<OpenElicitationResult> {
	const { conversationId, server, tool, args, inputRequired } = opts;
	const entries = Object.entries(inputRequired.inputRequests);

	let key: string | undefined;
	let payload: Extract<ReturnType<typeof normalizeElicitationRequest>, { ok: true }>["payload"] | undefined;
	for (const [k, req] of entries) {
		const normalized = normalizeElicitationRequest(req);
		if (normalized.ok) {
			key = k;
			payload = normalized.payload;
			break;
		}
	}
	if (!key || !payload) {
		return { opened: false, reason: "no supported (elicitation-shaped) input request in the batch" };
	}
	if (entries.length > 1) {
		logger.warn(
			{ server, tool, keys: entries.map(([k]) => k) },
			"[mcp] input_required batch has more than one entry — only the first elicitation-shaped one is parked (CUR-1017 v1)"
		);
	}

	const now = new Date();
	const inserted = await collections.mcpElicitations.insertOne({
		conversationId,
		status: "pending",
		request: { server, ...payload },
		pending: {
			server,
			tool,
			args,
			...(inputRequired.requestState !== undefined ? { requestState: inputRequired.requestState } : {}),
			inputKey: key,
		},
		createdAt: now,
		updatedAt: now,
	});
	return { opened: true, elicitationId: inserted.insertedId.toHexString() };
}

export type SubmitResult =
	| { ok: true; resume: boolean; pending: McpElicitation["pending"] }
	| { ok: false; status: 400 | 404 | 409; error: string };

/** Answer a parked elicitation. Re-validates `content` against the STORED field schema, never
 *  trusting the client's own shape-only check — same posture as the answer route it backs.
 *  `status: "pending"` in the update filter is the CAS: a double submit is a no-op 409, not a
 *  second, different answer overwriting the first. */
export async function submitElicitationAnswer(opts: {
	elicitationId: string;
	conversationId: ObjectId;
	action: ElicitationAction;
	content?: unknown;
}): Promise<SubmitResult> {
	const { elicitationId, conversationId, action, content } = opts;

	let id: ObjectId;
	try {
		id = new ObjectId(elicitationId);
	} catch {
		return { ok: false, status: 404, error: "Unknown elicitation." };
	}

	// Scoped by conversation: holding an id is not authority to answer someone else's prompt.
	const doc = await collections.mcpElicitations.findOne({ _id: id, conversationId });
	if (!doc) return { ok: false, status: 404, error: "Unknown elicitation." };
	if (doc.status !== "pending") return { ok: false, status: 409, error: "Already answered." };

	let validated: Record<string, ElicitationValue> | undefined;
	if (action === "accept" && doc.request.mode === "form") {
		const result = validateElicitationContent(doc.request.fields ?? [], content ?? {});
		if (!result.ok) return { ok: false, status: 400, error: result.error };
		validated = result.content;
	}

	const updated = await collections.mcpElicitations.updateOne(
		{ _id: id, conversationId, status: "pending" },
		{
			$set: {
				status: "resolved",
				action,
				resolvedAt: new Date(),
				updatedAt: new Date(),
				...(validated ? { content: validated } : {}),
			},
		}
	);
	if (updated.matchedCount === 0) return { ok: false, status: 409, error: "Already answered." };

	return { ok: true, resume: true, pending: doc.pending };
}
