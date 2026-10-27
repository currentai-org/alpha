import { flagEnabledOr } from "$lib/chat/server/flags";

// The entity-name-correction search branch needs a feature flag, not just `config.FIRECRAWL_API_KEY`
// presence, which is config rather than a switch (CUR-917). Unlike
// `workspaces`/`low-resource-language-fallback`, the feature is live with no documented output
// concern, so the fallback here is default-ON: a flag defaulting off would be an unannounced
// regression, not a safety improvement. This flag is a rollback lever, not a rollout gate.

/** PostHog flag key. Owner: chat. */
export const ENTITY_NAME_CORRECTION_FLAG = "entity-name-correction";

/** Is the entity-name-correction search branch on for this deployment? Sync, never throws. */
export function entityNameCorrectionEnabled(): boolean {
	return flagEnabledOr(ENTITY_NAME_CORRECTION_FLAG, () => true);
}
