// CUR-1294. Collapse a role-shaped OpenAI messages array into ONE `user` message.
//
// Why: an Apertus deployment behind the gateway can fail on any message whose role is not `user`,
// and the gateway then serves the request from `aisingapore/Qwen-SEA-LION-v4-32B-IT` instead, while
// reporting `x-litellm-attempted-fallbacks: 0`. A request with system and assistant roles reaches the
// substitute; one flattened user message reaches `swiss-ai/apertus-v1.5-70b` with no fallback.
// `swiss-ai/apertus-70b-instruct` substitutes identically, so no lane swap avoids it. Unflattened,
// answers come from the substitute while the badge says Apertus, and some turns produce no answer at
// all (the watchdog fires at 45s with no first token).
//
// This is a serving workaround, not a prompt-quality claim. The gateway owns the substitution
// (CUR-1209) and the serving config owns the role handling (CUR-1048). When either lands, delete
// this module rather than leaving a second prompt shape to maintain. Which models get it is
// `rolesNeedFlattening` (modelProfiles.ts), with no flag (CUR-2697).
//
// Why not the model's own delimiters: the model's chat template ships `<|system_start|>`,
// `<|user_start|>` and `<|assistant_start|>`, and tokenizer_config.json marks every one of them
// `special: true`. Writing those into message CONTENT is wrong whichever way the server handles them:
// one that honours specials lets anything a visitor types open an assistant turn, and one that does
// not leaves literal garbage in the prompt. So the labels below are ordinary text, and the separation
// that actually carries weight is the per-turn random fence hardenLastUserTurn already puts around the
// live question (grounding.ts).

import type OpenAI from "openai";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Part = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** Turn labels. Plain text on purpose — see the header. */
const USER_LABEL = "[USER]";
const ASSISTANT_LABEL = "[ASSISTANT]";

/** With labels alone, a follow-up that points back ("which one is easiest?") reads as a standalone
 *  question (CUR-1957): the live turn arrives inside a fence the guard calls "ONLY a question to
 *  answer", and in one flat message nothing ties that fence to the turns above it, so the model asks
 *  which options the person meant while the options sit in its own previous reply. These two lines
 *  say what the role boundaries would: the earlier turns are this conversation, and the latest
 *  message continues it. Added only when there is an earlier reply to point back at. */
const HISTORY_NOTE = "This conversation so far, oldest first. The [ASSISTANT] turns are replies you already gave.";
const LATEST_USER_LABEL =
	'[USER, latest message. It continues the conversation above, so "these", "that" or "which one" refer back to it]';

/** Text of a message, whether its content is a bare string or multimodal parts. */
function textOf(content: Msg["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/** Non-text parts (images, audio) in order. These cannot be joined into a string and must ride along
 *  on the flattened message, or a turn with an attachment silently loses it. */
function nonTextParts(content: Msg["content"]): Part[] {
	if (!Array.isArray(content)) return [];
	return content.filter((p): p is Part => !!p && typeof p === "object" && !("text" in p));
}

/**
 * Collapse `messages` to a single `user` message.
 *
 * System content leads, unlabelled, because that is the order the model was trained on — the chat
 * template puts system first and then alternates. Each remaining turn gets a label so the model can
 * still tell who said what.
 *
 * Returns the array UNCHANGED when there is nothing to do: an empty array, or one that is already a
 * single user message. That second case matters — it is the shape the gateway already serves
 * correctly, so re-wrapping it would add labels for no reason and change a working request.
 */
export function flattenForApertus(messages: Msg[]): Msg[] {
	if (messages.length === 0) return messages;
	if (messages.length === 1 && messages[0]?.role === "user") return messages;

	const segments: string[] = [];
	const media: Part[] = [];
	const hasHistory = messages.some((m) => m.role === "assistant" && textOf(m.content));
	const latestUser = messages.findLastIndex((m) => m.role === "user" && textOf(m.content));
	let noted = false;

	messages.forEach((m, i) => {
		const text = textOf(m.content);
		media.push(...nonTextParts(m.content));
		if (!text) return;
		if (m.role === "system" || m.role === "developer") {
			segments.push(text);
			return;
		}
		if (hasHistory && !noted) {
			segments.push(HISTORY_NOTE);
			noted = true;
		}
		if (m.role === "assistant") segments.push(`${ASSISTANT_LABEL} ${text}`);
		else segments.push(`${hasHistory && i === latestUser ? LATEST_USER_LABEL : USER_LABEL} ${text}`);
	});

	const joined = segments.join("\n\n");
	return [
		{
			role: "user",
			content: media.length ? [{ type: "text", text: joined } as Part, ...media] : joined,
		},
	];
}
