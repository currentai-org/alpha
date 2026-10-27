// The caller writes two things that land in the model's system role. Any visitor can POST a
// preprompt when creating a conversation; any account can save Settings → Personalization text. The
// input gate screens user turns only, so instructions placed there would skip it while each typed turn
// stayed harmless. This bounds that text and hands it to the guard as part of the turn it shapes. A
// model's own configured preprompt comes from our config and is left uncapped and unscreened. (CUR-3528)

import type { GuardScreenInput } from "./guardScreenTypes";

/** The longest client-written system text accepted, in characters: well past any real Personalization
 *  note, and short enough that it cannot crowd a turn out of the guard's window. */
export const CLIENT_INSTRUCTIONS_MAX_CHARS = 8000;

/** True when `text` is caller-written system text over the cap. A copy of the model's own preprompt
 *  (what the client sends when nobody customised anything) is never refused. */
export function exceedsClientInstructionsCap(text: string | undefined, modelPreprompt?: string): boolean {
	if (!text || text === modelPreprompt) return false;
	return text.length > CLIENT_INSTRUCTIONS_MAX_CHARS;
}

/**
 * The system text this turn will carry that a caller wrote: Personalization when it is on (it wins,
 * see `effectivePreprompt`), otherwise the conversation's preprompt unless it is just the model's own.
 * Undefined when there is none.
 */
export function clientAuthoredInstructions(
	convPreprompt: string | undefined,
	modelPreprompt: string | undefined,
	personalInstructions: string | null | undefined
): string | undefined {
	if (personalInstructions?.trim()) return personalInstructions;
	const conv = convPreprompt?.trim();
	if (!conv || convPreprompt === modelPreprompt) return undefined;
	return convPreprompt;
}

/**
 * Add caller-written instructions to the guard's corpus. They go at the END: the guard screens the
 * corpus's last GUARD_CORPUS_CAP characters (guardChunkTexts), so a long history would push text at
 * the front out of view. Capped here too, for a preprompt stored before the create-time cap existed.
 */
export function withClientInstructions(
	screen: GuardScreenInput,
	instructions: string | undefined
): GuardScreenInput {
	if (!instructions) return screen;
	const bounded = instructions.slice(0, CLIENT_INSTRUCTIONS_MAX_CHARS);
	return { ...screen, corpus: screen.corpus ? `${screen.corpus}\n\n${bounded}` : bounded };
}
