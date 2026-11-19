// The Mila suicide-prevention output guard (flag `mila-sp-output-guard`). With the flag on, the chat route
// checks each turn's finished English or French answer with the Mila classifier (detectors/milaSp.ts). The
// answer streams and stays as it is; a hit shows the crisis card under it and ends the conversation.
// Separate from OUTPUT_MODERATION, which it neither reads nor changes.
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import type { MinimalLogger } from "$lib/chat/server/guardScreenTypes";
import { milaSpConfigured, milaSpScore } from "$lib/chat/server/detectors/milaSp";
import { declineLanguageFromTag, readMessageLanguage } from "$lib/chat/server/declineCopy";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { MILA_SP_GUARD } from "../../../../config/safetyScreen";

/** Registered in flagKeys.ts. Default OFF: no turn is checked. */
export const MILA_SP_OUTPUT_GUARD_FLAG = "mila-sp-output-guard";

/** Whether this turn's finished answer is checked. Flag on with the key or the endpoint unset is a loud misconfiguration:
 *  one error for the turn, and the turn is not checked (fail open). Called once per turn. */
export function milaSpOutputGuardOn(log: MinimalLogger = defaultLogger): boolean {
	if (!flagEnabledOr(MILA_SP_OUTPUT_GUARD_FLAG, () => false)) return false;
	if (!milaSpConfigured()) {
		log.error(
			{ gateSource: "mila-sp" },
			`[mila-sp] mila-sp-output-guard is ON but ${MILA_SP_GUARD.provider.api_key_env} or ${MILA_SP_GUARD.provider.api_base_env} is unset — this turn's answer is not checked`
		);
		return false;
	}
	return true;
}

/** The answer languages the model card covers, as the 639-3 tags readMessageLanguage returns. */
const CHECKED_LANGUAGES = ["eng", "fra"];

export type MilaSpAnswerCheck = {
	/** This turn's answer text, think blocks stripped. */
	answer: string;
	/** The turn's assistant message. Its moderation object is mutated in place, never replaced: the support
	 *  signal holds the same object across its await and writes `supportCountry` to it later. */
	message: Pick<Message, "moderation">;
	/** The conversation being answered; a hit stamps `crisisEndedAt` on it. */
	conv: { crisisEndedAt?: Date };
	signal: AbortSignal;
	/** The route's persistConversation: never rejects, and saves `conv.crisisEndedAt` with the messages. */
	persist: () => Promise<void>;
	/** The route's update(), which records the update on the message and sends it to the client. */
	update: (event: MessageUpdate) => Promise<void>;
	log?: MinimalLogger;
	score?: typeof milaSpScore;
	readLanguage?: typeof readMessageLanguage;
};

/** Check a finished answer and, on a hit, show the card and end the conversation: the stamp is saved
 *  before the client is told. Run after the answer has streamed and before the turn's Finished status.
 *  Any check it cannot finish changes nothing (fail open). */
export async function checkAnswerWithMilaSp(c: MilaSpAnswerCheck): Promise<void> {
	const log = c.log ?? defaultLogger;
	if (!milaSpOutputGuardOn(log)) return;
	if (!c.answer.trim()) return;
	const tag = await (c.readLanguage ?? readMessageLanguage)(c.answer);
	const lang = CHECKED_LANGUAGES.find((l) => tag?.startsWith(l));
	if (!lang) return;
	const started = Date.now();
	const res = await (c.score ?? milaSpScore)(c.answer, c.signal);
	// The verdict only, never the text.
	log.info(
		{
			gateSource: "mila-sp",
			lang,
			verdict: res.verdict,
			score: res.verdict === "unknown" ? null : res.score,
			...(res.verdict === "unknown" ? { reason: res.reason } : {}),
			ms: Date.now() - started,
		},
		"[mila-sp] answer checked"
	);
	if (res.verdict !== "unsafe") return;
	const mod = (c.message.moderation ??= { flagged: false, label: null, score: 0, kind: "toxicity" });
	mod.support = true;
	mod.supportLang ??= declineLanguageFromTag(tag);
	c.conv.crisisEndedAt = new Date();
	await c.persist();
	await c.update({ type: MessageUpdateType.SupportNotice, supportLang: mod.supportLang, conversationEnded: true });
}
