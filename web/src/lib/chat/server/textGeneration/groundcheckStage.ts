import { type MessageUpdate, MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import type { GroundcheckOutcome } from "$lib/chat/types/Message";
import { groundcheckAnswer, groundcheckEmptiedText, groundcheckItemsRemovedText } from "../groundcheck";
import { declineLanguageOf } from "../declineCopy";

type FinalAnswer = Extract<MessageUpdate, { type: MessageUpdateType.FinalAnswer }>;

export interface GroundcheckStageOptions {
	/** The `groundcheck` flag, read once for the turn. */
	enabled: boolean;
	/** The evidence the answer is checked against, read when the answer is finished: what this turn
	 *  retrieved (by tool call or by the pipeline) plus attached files. Empty stands the check down. */
	evidence: () => Promise<string[]>;
	/** The numbered sources, named in the note that replaces an answer nothing supported. */
	sources: () => { n: number; title: string }[];
	question: string;
	/** True when this answer must ship as written: its numbers are code-rendered (a maths ledger or a
	 *  calculate call), the output screen stopped the turn, or a guard already replaced the answer. */
	standDown: () => boolean;
	/** Every outcome the check reached, including a detector that failed, so the turn can say so.
	 *  `beforeChars` is the answer's length going in, and `removed` the claims it deleted, both passed
	 *  only when the check changed it. */
	onOutcome: (outcome: GroundcheckOutcome, beforeChars?: number, removed?: number) => void;
	check?: typeof groundcheckAnswer;
	/** The language the items-removed line is written in, read from the answer. */
	languageOf?: typeof declineLanguageOf;
}

/**
 * Groundcheck (CUR-2467) for every harness, in one place. It runs on the finished answer
 * AFTER the output screen and the honesty stream, at the FinalAnswer every producer ends on.
 *
 * @remarks Native and scaffolded turns share this one copy. A copy inside native generation would run
 * before the output screen, and the screen composes its FinalAnswer from the tokens it released, so
 * every deletion it made would be discarded. Deletion-only, so every word that
 * can ship has already cleared the screen. Never throws: groundcheckAnswer fails open. (CUR-2765)
 */
export async function* groundcheckStage(
	source: AsyncIterable<MessageUpdate>,
	opts: GroundcheckStageOptions
): AsyncGenerator<MessageUpdate> {
	for await (const event of source) {
		if (event.type !== MessageUpdateType.FinalAnswer) {
			yield event;
			continue;
		}
		yield await checkFinal(event, opts);
	}
}

async function checkFinal(final: FinalAnswer, opts: GroundcheckStageOptions): Promise<FinalAnswer> {
	// A decline is copy we wrote, and an interrupted answer was cut off mid-claim.
	if (!opts.enabled || final.interrupted || final.declineText || final.declineNotice) return final;
	const context = await opts.evidence();
	if (context.length === 0) return final;
	// A sourced answer that stands down still says so. Unstamped, it reads like a turn that had nothing
	// to check, which is the blank this stage exists to remove.
	if (opts.standDown()) {
		opts.onOutcome("stood-down");
		return final;
	}
	const res = await (opts.check ?? groundcheckAnswer)({ answer: final.text, context, question: opts.question });
	if (res.outcome !== "revised" && res.outcome !== "emptied") {
		opts.onOutcome(res.outcome);
		return final;
	}
	// "" means nothing in the answer was supported: say so and point at the sources instead.
	const text = res.text === "" ? groundcheckEmptiedText(opts.sources()) : res.text;
	if (!/[\p{L}\p{N}]/u.test(text)) {
		opts.onOutcome("kept");
		return final;
	}
	opts.onOutcome(res.outcome, final.text.length, res.removed);
	// A list that lost items says so under the answer (CUR-4489): its count and numbering now match
	// what is left, and the reader would otherwise never know the model offered more.
	if (res.outcome === "revised" && res.items) {
		const lang = await (opts.languageOf ?? declineLanguageOf)(text).catch(() => "en" as const);
		const note = groundcheckItemsRemovedText(res.items, lang);
		return { ...final, text: `${text}\n\n${note}` };
	}
	return { ...final, text };
}
