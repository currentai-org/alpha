/** `customPrompts` key for Settings → Personalization: instructions that apply to every model. */
export const PERSONAL_INSTRUCTIONS_KEY = "*";

/**
 * The person's Personalization instructions as they stand right now, or null when there are none or
 * they are switched off. Read on every turn (turnPreferences.ts), never copied into a conversation,
 * so an edit reaches the next answer in a chat that is already open (CUR-1443).
 */
export function personalInstructionsFrom(
	settings:
		| { customPrompts?: Record<string, string>; customPromptsEnabled?: Record<string, boolean> }
		| null
		| undefined
): string | null {
	const text = settings?.customPrompts?.[PERSONAL_INSTRUCTIONS_KEY]?.trim();
	if (!text) return null;
	return (settings?.customPromptsEnabled?.[PERSONAL_INSTRUCTIONS_KEY] ?? true) ? text : null;
}
