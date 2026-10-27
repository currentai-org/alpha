import { z } from "zod";
import { SEARCH_ENGINES } from "$lib/chat/types/Search";
import { isMessageId } from "$lib/chat/utils/tree/isMessageId";

/**
 * Schema for the JSON `data` field of a chat POST (multipart form). Validates the prompt, the
 * tree position (parent/retry message id), the client-minted generation id used for idempotency,
 * MCP selection, timezone, and the open-web search grounding the client attached for this turn.
 * Kept beside the route so the contract is testable in isolation from the streaming handler.
 */
export const chatRequestSchema = z.object({
	id: z.string().uuid().refine(isMessageId).optional(), // parent message id to append to for a normal message, or the message id for a retry/continue
	// client-chosen id for this generation run, echoed back by the stop
	// request so a stop point can be matched to the run it belongs to
	generationId: z.string().uuid().optional(),
	// The ids the page minted for this turn's new messages. The server uses them when they are free,
	// so its post-turn snapshot carries the same ids and the page doesn't remount the answer (CUR-2098).
	newMessageIds: z
		.object({
			user: z.string().uuid().refine(isMessageId).optional(),
			assistant: z.string().uuid().refine(isMessageId).optional(),
		})
		.optional(),
	inputs: z.optional(
		z
			.string()
			.min(1)
			.transform((s) => s.replace(/\r\n/g, "\n"))
	),
	is_retry: z.optional(z.boolean()),
	// re-attach the assistant message `id` to the agent task it already started, after the tab
	// that started it closed. No prompt rides along; the task's replayed events rewrite the message. (CUR-993)
	agent_attach: z.optional(z.boolean()),
	selectedMcpServerNames: z.optional(z.array(z.string())),
	selectedMcpServers: z
		.optional(
			z.array(
				z.object({
					name: z.string(),
					url: z.string(),
					headers: z
						.optional(z.array(z.object({ key: z.string(), value: z.string() })))
						.default([]),
				})
			)
		)
		.default([]),
	timezone: z.optional(z.string()),
	// LEGACY (kept ≥1 release for deploy-skew): a boolean that only expressed "always". The server now
	// prefers `speakMode` (below) and reads `speakAll` only when `speakMode` is absent (old client).
	speakAll: z.optional(z.boolean()),
	// Speak preference for this turn (composer Speak control), tri-state like webSearchMode:
	//   off    = never synthesize (the server runs no read-aloud/TTS path this turn);
	//   auto   = speak when the turn reads as a read-aloud request;
	//   always = synthesize + speak every answer.
	// `speakAll` alone can't express "off" (it collapses off and auto to false), so the server must read
	// this to honor an explicit off. Consumed in textGeneration (effectiveSpeakMode).
	speakMode: z.optional(z.enum(["off", "auto", "always"])),
	// Agent toggle for this turn (composer Agent control): off = normal model, on = force the agent,
	// auto = server asks the agent service's /route classifier. A per-turn client preference. The server's
	// resolveAgentRoute consumes it (see conversation/[id]/+server.ts).
	agentMode: z.optional(z.enum(["off", "auto", "on"])),
	// Open-web search preference for this turn (composer globe control), replacing the old boolean.
	//   off    = never search; auto = community/RAG first, web only if community is insufficient AND the
	//   margin gate fires; always = web always runs (skips the margin gate). The server sequences
	//   community-first and decides the web fallback (see conversation/[id]/+server.ts). Default "off".
	webSearchMode: z.optional(z.enum(["off", "auto", "always"])),
	// The picker was on Auto and Auto chose this turn's model in the browser. `model` is the
	// catalog id it chose, `reasons` its chips ("Spanish", "Medium task") and `explanation` the sentence
	// the composer showed. The server keeps it only when `model` is the model this turn runs on. (CUR-3944)
	autoRoute: z.optional(
		z.object({
			model: z.string().max(80),
			reasons: z.array(z.string().max(60)).max(6),
			explanation: z.string().max(600),
			// Auto's first choice for this question, which was busy or silent, so this turn is
			// Auto picking again. The one retry that keeps an Auto claim. (CUR-4384)
			repickedFrom: z.optional(z.string().max(80)),
		})
	),
	// LEGACY — ignored for grounding. The POST handler does not read it: web search runs SERVER-side
	// after RAG and the grounding gate (relevanceVerified) lives there (conversation/[id]/+server.ts),
	// so a client can't claim grounding by supplying this. Still parsed + size-capped for older
	// clients that send it — never trusted as verified evidence.
	searchContext: z.optional(
		z.object({
			query: z.string().max(400),
			asOf: z.string().max(40),
			evidence: z.string().max(20_000),
			sources: z
				.array(
					z.object({
						n: z.number(),
						title: z.string(),
						url: z.string(),
						snippet: z.string(),
						engine: z.enum(SEARCH_ENGINES),
						asOf: z.string().optional(),
						lang: z.string().optional(),
						imageUrl: z.string().optional(),
					})
				)
				.max(20),
		})
	),
	files: z.optional(
		z.array(
			z.object({
				type: z.literal("base64").or(z.literal("hash")),
				name: z.string(),
				value: z.string(),
				mime: z.string(),
			})
		)
	),
});

export type ChatRequestPayload = z.infer<typeof chatRequestSchema>;
