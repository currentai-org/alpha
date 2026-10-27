// Cut a generation that is stuck repeating itself while it streams, before output moderation reads it
// (CUR-3318). A model that loops thousands of characters of "No crushing. No smashing. No breaking…"
// is read in full by the output screen, which can decline the answer as violent, so the visitor's last
// sight is a content-policy decline. repetitionGuard.ts cannot help there: it
// runs on the finished answer inside honestyStream.ts, after a full decline has already returned.
//
// This stage sits on the raw generation, ahead of the screen. It reads every run of SPAN_WORDS
// consecutive words outside code fences and asks of the last WINDOW_WORDS words how many of their spans
// are new to this answer. A loop adds nothing new, so the count falls to zero within one window; once it
// is MAX_NEW or fewer, the stage stops reading the model (which ends the upstream request) and closes the
// answer with the fixed notice. A count of how often one span recurs could not tell the loop from an
// honest list: eight days that each read "The museum is open from 9 to 5" repeat that span eight times,
// but each line's day name makes its spans new, so the window never empties.

import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger.js";
import type { DeclineLanguage } from "$lib/chat/server/declineCopy";
import { repetitionNotice } from "./repetitionGuard";

/**
 * PostHog flag key. A killswitch: on unless set off, because it repairs a live defect (CUR-3318).
 * @internal exported for the flag registry spec
 */
export const LOOP_CUT_FLAG = "loop-cut";

function loopCutEnabled(): boolean {
	return flagEnabledOr(LOOP_CUT_FLAG, () => true);
}

/** Consecutive words in the span that is counted. */
const SPAN_WORDS = 6;

/**
 * The trailing words the novelty test reads, and the most of their spans that may be new while the
 * answer is still cut. Together: about a paragraph that says nothing it has not already said.
 * @internal exported for the specs
 */
export const WINDOW_WORDS = 60;
const MAX_NEW = 6;

const WORD_RE = /[\p{L}\p{N}']+/gu;
const FENCE = "```";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const THINK_TAG_RE = /(<\/?think>)/;

/**
 * `skipReasoning`: leave everything inside `<think>…</think>` unread. An agent turn's reasoning block is
 * its step trace, and the agent narrates between steps in near-identical sentences ("Created
 * x.xlsx…", "x.xlsx is in your folder…") while it checks its own file. Read as a loop, that trace would
 * be cut before `</think>`, and a finished file turn would show "No answer" (CUR-4105). The agent service bounds the trace itself (step and frame caps).
 */
export interface LoopCutOptions {
	skipReasoning?: boolean;
}

/**
 * Reads text as it arrives. `push` returns the latest span once the last WINDOW_WORDS words have added
 * MAX_NEW or fewer spans this answer had not already used, else null.
 * @internal exported for the specs
 */
export function createLoopCounter(options: LoopCutOptions = {}) {
	const seen = new Set<string>();
	const words: string[] = [];
	const fresh: boolean[] = [];
	let freshInWindow = 0;
	let carry = "";
	let inFence = false;
	let inReasoning = false;

	const readWords = (prose: string): string | null => {
		for (const word of prose.toLowerCase().match(WORD_RE) ?? []) {
			words.push(word);
			if (words.length > SPAN_WORDS) words.shift();
			if (words.length < SPAN_WORDS) continue;
			const span = words.join(" ");
			const isNew = !seen.has(span);
			seen.add(span);
			fresh.push(isNew);
			if (isNew) freshInWindow++;
			if (fresh.length > WINDOW_WORDS && fresh.shift()) freshInWindow--;
			if (fresh.length === WINDOW_WORDS && freshInWindow <= MAX_NEW) return span;
		}
		return null;
	};

	// The answer after a reasoning block restates it: the agent's trace ends with its summary and the
	// answer is that summary again (CUR-4105). Each side is read for loops on its own.
	const endReasoning = () => {
		seen.clear();
		words.length = 0;
		fresh.length = 0;
		freshInWindow = 0;
		inFence = false;
	};

	return {
		push(token: string): string | null {
			const text = carry + token;
			// Hold back what the next token may finish: a word, a fence marker, a closing tag.
			let end = text.length;
			while (end > 0 && /[\p{L}\p{N}'`]/u.test(text[end - 1])) end--;
			const open = text.lastIndexOf("<", end - 1);
			if (open >= 0 && open >= end - THINK_CLOSE.length && !text.includes(">", open)) end = open;
			carry = text.slice(end);
			for (const segment of text.slice(0, end).split(THINK_TAG_RE)) {
				if (segment === THINK_OPEN) {
					inReasoning = true;
					continue;
				}
				if (segment === THINK_CLOSE) {
					inReasoning = false;
					endReasoning();
					continue;
				}
				if (inReasoning && options.skipReasoning) continue;
				const parts = segment.split(FENCE);
				for (let i = 0; i < parts.length; i++) {
					if (i > 0) inFence = !inFence;
					if (inFence) continue;
					const hit = readWords(parts[i]);
					if (hit) return hit;
				}
			}
			return null;
		},
		/** True while a `<think>` block the counter has read is still open. */
		reasoningOpen(): boolean {
			return inReasoning;
		},
	};
}

/**
 * Pass the generation through until its last WINDOW_WORDS words add almost nothing new, then stop reading it and end the
 * answer with the fixed notice. Everything else passes through unchanged.
 */
/** `language`: the language the person wrote in, awaited only when a loop is cut, so the notice reads in
 *  it (CUR-4052). A cut inside an open `<think>` closes it first: the notice is the answer, and left
 *  inside the reasoning block it rendered as "No answer was produced" (CUR-4105). */
export async function* cutRepetitionLoop(
	source: AsyncIterable<MessageUpdate>,
	language?: Promise<DeclineLanguage>,
	options: LoopCutOptions = {}
): AsyncGenerator<MessageUpdate> {
	if (!loopCutEnabled()) {
		yield* source;
		return;
	}
	const counter = createLoopCounter(options);
	let streamed = "";
	for await (const event of source) {
		if (event.type !== MessageUpdateType.Stream) {
			yield event;
			continue;
		}
		yield event;
		streamed += event.token;
		const span = counter.push(event.token);
		if (!span) continue;
		logger.warn(
			{ span, window: WINDOW_WORDS, chars: streamed.length },
			"[loop-cut] the answer is repeating one span; generation stopped before the output screen"
		);
		const close = counter.reasoningOpen() ? `\n${THINK_CLOSE}` : "";
		const notice = `${close}\n\n${repetitionNotice(await (language ?? Promise.resolve("en" as const)))}`;
		yield { type: MessageUpdateType.Stream, token: notice };
		yield { type: MessageUpdateType.FinalAnswer, text: streamed + notice, interrupted: false };
		// Leaving the loop returns the source, which ends the model request.
		return;
	}
}
