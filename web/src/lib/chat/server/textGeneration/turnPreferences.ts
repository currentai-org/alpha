// A person's answer settings have to reach the model on the turn they send right now, re-read every
// time, the same conversation or a new one. `createConversation.ts`'s `customPrompts[model]` copy into
// `conv.preprompt` can't carry them: it is baked in once at creation and never re-read. This resolves
// the turn-path inputs the same way `layoutData.ts` resolves Settings for a page load
// (`collections.settings.findOne(authCondition(locals))`), called here per turn instead of once per
// navigation.
//
// The reply-language rule is one case: a global rollout flag (`replyLanguageRuleEnabled`), overridable
// per account. An account with no preference set falls back to the flag, so anyone who hasn't touched
// the control gets the flag's behavior.

import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { replyLanguageRuleEnabled } from "./replyLanguageGate";
import { personalInstructionsFrom } from "$lib/chat/personalInstructions";
import { type AnswerPreferences, resolveAnswerPreferences } from "$lib/chat/answerPreferences";

export interface TurnPreferences {
	/** The in-language reply rule. Account setting wins when set; otherwise the rollout flag. */
	replyInUserLanguage: boolean;
	/**
	 * Whether answers use the warmer first-person register, carried here for the readers that predate
	 * `answer`. The turn reads it from `answer.selfReferenceAsPerson`: persona.ts `styleFor` selects the
	 * person clause and the person few-shot variant, and answerClauses.ts `answerVoiceFor` the sentence
	 * on the other prompt paths.
	 */
	selfReferenceAsPerson: boolean;
	/** Settings → Personalization, as saved now; null when empty or switched off. Optional so the
	 *  specs that stub this resolver with only the language field keep compiling. */
	personalInstructions?: string | null;
	/** How Alpha writes to this person (answerPreferences.ts), every field resolved to a
	 *  value. Optional for the same reason as `personalInstructions`; a reader treats absent as the
	 *  defaults. */
	answer?: AnswerPreferences;
	/** The person's past-chat search switch, as saved now. The turn also needs the flag and an
	 *  account (pastChatSearchGate.ts). Optional for the same reason as `personalInstructions`. */
	searchPastChats?: boolean;
}

/**
 * The extra instructions for this turn: the person's current Personalization text when they have
 * some, otherwise what the conversation was created with (a per-model prompt or the model's own).
 * The turn, the native-tools turn and the conversation API all call this, so what the page shows as
 * the system prompt is what the next answer gets.
 */
export function effectivePreprompt(
	convPreprompt: string | undefined,
	prefs: Pick<TurnPreferences, "personalInstructions">
): string | undefined {
	return prefs.personalInstructions ?? convPreprompt;
}

/**
 * Resolve this turn's account-level preferences. `locals` absent or no Settings document (a guest
 * with no persisted row, or a lookup failure) falls back to the same defaults the flag/hardcoded
 * behavior already give every account today — never a hard failure on the turn path for this.
 */
export async function resolveTurnPreferences(locals: App.Locals | undefined): Promise<TurnPreferences> {
	const settings = locals ? await collections.settings.findOne(authCondition(locals)) : null;
	return {
		replyInUserLanguage: settings?.replyInUserLanguage ?? replyLanguageRuleEnabled(),
		selfReferenceAsPerson: settings?.selfReferenceAsPerson ?? false,
		personalInstructions: personalInstructionsFrom(settings),
		answer: resolveAnswerPreferences(settings),
		searchPastChats: settings?.searchPastChats === true,
	};
}
