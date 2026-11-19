/**
 * Continue in a new chat: one side call that summarises a conversation close to its delete
 * date, so the person can carry what mattered into a new chat, which starts its own 30 days. The summary
 * goes back to the browser and into the new chat's composer for the person to edit; nothing is stored
 * here, and the old conversation is never written.
 */
import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { earlierTurns } from "$lib/chat/server/secondOpinionContext";
import { logger } from "$lib/chat/server/logger";
import type { Message } from "$lib/chat/types/Message";

/** How much of the chat the summary reads: its latest turns on the current branch, each cut. */
const SUMMARY_TURNS = 40;
const SUMMARY_TURN_CHARS = 2_000;

/** A person is waiting on this one call, with nothing else to show, so it gets longer than a turn's side calls. */
const SUMMARY_TIMEOUT_MS = 30_000;

// Every call starts with this same system text, then the transcript. The gateway's lanes take no
// cache_control marker (supportSignal.ts says the same), so the prefix is kept byte-stable for a
// provider-side prefix cache to hit.
const SUMMARY_SYSTEM =
	"You write the opening message of a new chat that continues an earlier one. The earlier chat is about to " +
	"be deleted, and the person will read and edit what you write before sending it. Write it in the language " +
	"the person used, in the first person, as the person speaking to the assistant: start with one line saying " +
	"this continues an earlier conversation, then the facts, decisions, open questions and preferences the " +
	"assistant needs to pick up where it left off, as short plain sentences or a short list. Leave out greetings, " +
	"thanks and anything the conversation settled and dropped. Keep it under 200 words. Reply with the message only.";

/** The summary a `canned_reply` request gets: fixed text, made without a model call. */
export function cannedContinueSummary(conversation: { title?: string }): string {
	return `Continuing an earlier conversation${conversation.title ? ` ("${conversation.title}")` : ""}. Canned summary for a test.`;
}

/** The title a conversation holds until its first title lands (title.ts writes over only this one). */
const UNTITLED = "New Chat";

/**
 * The summary as the new chat's composer gets it: the old chat's title first, then the model's text. The
 * model was left to say what the chat was about and, on develop, named the topic in none of three live
 * runs, so the title is put there by code. A blank or still-default title adds nothing; a
 * sealed conversation's plaintext title is blank, so it gets the model's text alone.
 */
function withChatTitle(title: string | undefined, summary: string): string {
	const name = title?.trim();
	if (!summary || !name || name === UNTITLED) return summary;
	return `Continuing “${name}”:\n\n${summary}`;
}

/**
 * The summary of `conversation` along the branch ending at `leafId` (its newest message when omitted),
 * led by its title (withChatTitle), or "" when the conversation has nothing to summarise or the call
 * failed.
 */
export async function summariseForContinue(
	conversation: { messages: Message[]; rootMessageId?: Message["id"]; title?: string },
	leafId: Message["id"] | undefined,
	locals: App.Locals | undefined
): Promise<string> {
	const leaf = leafId ?? conversation.messages.at(-1)?.id;
	if (!leaf) return "";
	const turns = earlierTurns(conversation, leaf, {
		turns: SUMMARY_TURNS,
		chars: SUMMARY_TURN_CHARS,
		throughParent: true,
	});
	if (!turns.length) return "";
	const transcript = turns.map((t) => `${t.from === "user" ? "Person" : "Assistant"}: ${t.content}`).join("\n\n");
	const started = Date.now();
	let failure: string | undefined;
	const summary = await getReturnFromGenerator(
		generateFromDefaultEndpoint({
			messages: [{ from: "user", content: `The earlier chat:\n\n${transcript}` }],
			preprompt: SUMMARY_SYSTEM,
			// The summary is free text the person edits, so there is no shape to enforce; thinking is off so the
			// budget goes to the message rather than to reasoning about it.
			generateSettings: { max_tokens: 1_024, temperature: 0.3 },
			disableThinking: true,
			timeoutMs: SUMMARY_TIMEOUT_MS,
			onFailure: (kind, status) => {
				failure = status ? `${kind}:${status}` : kind;
			},
			locals,
		})
	).catch(() => "");
	// Lengths and timing only: the text is the person's conversation.
	logger.info(
		{ turns: turns.length, chars: summary.length, ms: Date.now() - started, failure },
		"[continue] summary"
	);
	return withChatTitle(conversation.title, summary.trim());
}
