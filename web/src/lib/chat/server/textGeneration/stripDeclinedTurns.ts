import type { Message } from "$lib/chat/types/Message";
import { neutralizeAdoptedName } from "../nameGuard";

/**
 * Strip moderation-DECLINED turns from the model's context.
 *
 * A declined turn never reached the model: what's stored is the user's flagged request plus the
 * canned decline copy. Feeding that pair back as history contaminates every later turn — the model
 * anchors on the flagged request in context and re-refuses (or stays on the flagged topic) for
 * unrelated follow-ups. After a declined spyware prompt, "how's the weather" can get a freshly
 * generated refusal about the spyware, text that never existed in the declined turn, so the
 * contamination is prompt-level, not a display bug.
 *
 * The `moderation` marker exists only on declines (`moderationMarker` pins `flagged: true`; it is
 * never stamped on an answered turn), so this cannot drop a legitimate exchange. Redact/advisory
 * turns carry `safetyNotice`, not `moderation` — the model answered those, and they stay.
 *
 * Removes the declined assistant AND its immediately-preceding user turn (the flagged request is
 * the contaminant, not just the decline copy). The stored/displayed history is untouched — this
 * trims only the LLM input, the same contract as every other prompt transform.
 */
export function stripDeclinedTurns(messages: Message[]): Message[] {
	return messages.filter((m, i) => {
		if (m.from === "assistant" && m.moderation?.flagged) return false;
		const next = messages[i + 1];
		if (m.from === "user" && next?.from === "assistant" && next.moderation?.flagged) return false;
		return true;
	});
}

/**
 * The history every turn sends the model, whatever its harness (CUR-2697): declined pairs stripped,
 * and a personal name an earlier answer adopted (the name guard's `nameNotice`) neutralized, so it
 * cannot compound into an established identity over the session. Every message is a shallow copy:
 * the injection fence is written into the last user message in place, and an alias would carry it
 * into stored history, where it accumulates and the model starts echoing the delimiters.
 */
export function historyForModel(messages: Message[]): Message[] {
	return stripDeclinedTurns(messages).map((m) =>
		m.from === "assistant" && m.nameNotice?.name
			? { ...m, content: neutralizeAdoptedName(m.content, m.nameNotice.name) }
			: { ...m }
	);
}
