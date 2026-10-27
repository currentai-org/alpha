import { z } from "zod";
import { validModelIdSchema } from "$lib/chat/server/models";
import { DEFAULT_SETTINGS } from "$lib/chat/types/Settings";
import { logger } from "$lib/chat/server/logger";
import { CLIENT_INSTRUCTIONS_MAX_CHARS, exceedsClientInstructionsCap } from "$lib/chat/server/clientInstructions";
import { PERSONAL_INSTRUCTIONS_KEY } from "$lib/chat/personalInstructions";
import { ANSWER_LANGUAGES, EMOJIS, FORMATS, LENGTHS, TONES } from "$lib/chat/answerPreferences";
import { MAX_MCP_TOOL_POLICIES, MCP_TOOL_POLICIES } from "$lib/chat/mcpToolPolicy";

// The body schema for BOTH settings endpoints — `/chat/settings` and `/chat/api/v2/user/settings`.
// One shared definition, so a fix to it reaches both endpoints.
//
// WHY A FUNCTION AND NOT A MODULE-SCOPE `const`
//
// `validModelIdSchema` is an exported `let` that models.ts REASSIGNS (models.ts, in the publish
// path) once the live model list arrives — before that it is a permissive bare `z.string()`. A
// module-scope `z.object({ activeModel: validModelIdSchema })` captures whichever value happened to
// be current when the module first loaded, and import order then decides correctness: getting it
// wrong silently restores the bare `z.string()`, undoing CUR-770 while every test stays green. That
// is the "silently widening" failure a test's name should call out, so the schema is rebuilt
// per call from the current value instead. It costs a z.object() construction per request and cannot
// be wrong about ordering.
//
// WHY `activeModelSchema` IS A PARAMETER (CUR-1194): the default (the global `validModelIdSchema`
// above) only ever knows the shared, boot-once catalog — a per-user local (LAN/self-hosted) endpoint
// never appears in it, so validating a `local:*` id against the bare default would reject it. Both
// real call sites always pass their own per-request `getEffectiveValidModelIdSchema(locals)` (catalog
// + this user's local model, if any — localModels.ts); the default only exists so this module's own
// unit tests, and any future caller with no per-user registry to offer, still get the live
// global-registry behaviour.
export function settingsSchema(activeModelSchema: z.ZodType<string> = validModelIdSchema) {
	return z.object({
		welcomeModalSeen: z.boolean().optional(),
		// Validated against the live registry, same as a PATCH model change (CUR-770).
		//
		// ...but `.catch()`, not a bare throw. A throw from `settingsSchema.parse(body)` becomes a 500
		// for the whole request, so one stale field takes down every other field in the same write.
		// Dismissing the onboarding modal (`welcomeModalSeen`) persists through this endpoint, so with a
		// throw a user whose selected model has rotated out of the gateway pool cannot record dismissing
		// it, and the modal returns on every visit.
		//
		// Coercing to the default preserves CUR-770's intent (an unregistered or agent model id is
		// never persisted) while letting the rest of the write land. The warn is
		// deliberate: a model id falling out of the registry is worth seeing, and a silent `.catch()`
		// would trade a loud bug for an invisible one.
		activeModel: activeModelSchema.default(DEFAULT_SETTINGS.activeModel).catch((ctx) => {
			logger.warn(
				{ rejected: ctx.input, fallback: DEFAULT_SETTINGS.activeModel },
				"settings: activeModel is not in the live model registry — coercing to the default rather than failing the whole write"
			);
			return DEFAULT_SETTINGS.activeModel;
		}),
		// Personalization ("*") reaches every turn's system role, so it is bounded like a
		// create-time preprompt. Per-model entries are only ever copied into a new conversation's
		// preprompt, and the create route caps that. (CUR-3528)
		customPrompts: z
			.record(z.string(), z.string())
			.refine((p) => !exceedsClientInstructionsCap(p[PERSONAL_INSTRUCTIONS_KEY]), {
				message: `Personal instructions are limited to ${CLIENT_INSTRUCTIONS_MAX_CHARS} characters`,
				path: [PERSONAL_INSTRUCTIONS_KEY],
			})
			.default({}),
		customPromptsEnabled: z.record(z.string(), z.boolean()).default({}),
		multimodalOverrides: z.record(z.string(), z.boolean()).default({}),
		artifactsOverrides: z.record(z.string(), z.boolean()).default({}),
		reasoningEffortOverrides: z.record(z.string(), z.enum(["low", "medium", "high"])).default({}),
		reasoningOverrides: z.record(z.string(), z.boolean()).default({}),
		streamingMode: z.enum(["raw", "smooth"]).optional(),
		directPaste: z.boolean().default(false),
		hapticsEnabled: z.boolean().default(true),
		hidePromptExamples: z.record(z.string(), z.boolean()).default({}),
		billingOrganization: z.string().optional(),
		// account-level overrides for the turn-path preferences the CUR-1430 rules used to
		// hardcode. Optional and unset by default — see Settings.ts for the fallback each one gets. (CUR-1443)
		replyInUserLanguage: z.boolean().optional(),
		// How Alpha writes to this person (answerPreferences.ts). `null` is a reset, which
		// applySettingsUpdate turns into `$unset`; a value outside the list is refused, never coerced.
		// `selfReferenceAsPerson` is one of them, reset the same way (CUR-3930). (CUR-3929)
		selfReferenceAsPerson: z.boolean().nullable().optional(),
		tone: z.enum(TONES).nullable().optional(),
		answerLength: z.enum(LENGTHS).nullable().optional(),
		suggestions: z.boolean().nullable().optional(),
		answerLanguage: z.enum(ANSWER_LANGUAGES).nullable().optional(),
		plainLanguage: z.boolean().nullable().optional(),
		// The same shape for the milestone 7 fields; null unsets. `explainTerms` came off the page
		// under rule 4.6 (CUR-4288): an old client that still sends it is not refused, and the key is
		// stripped here, so it never reaches the row. (CUR-549)
		answerFormat: z.enum(FORMATS).nullable().optional(),
		emojis: z.enum(EMOJIS).nullable().optional(),
		showServing: z.boolean().nullable().optional(),
		// Settings → Connectors. Keys are `server__tool` names, which only ever hold
		// [a-zA-Z0-9_-] (serverTools.ts), so a key cannot be a Mongo operator or a dotted path. (CUR-3984)
		// The past-chat search switch. Off unless sent true. (CUR-4576)
		searchPastChats: z.boolean().optional(),
		// Agent mode asks before every step only when this is sent true; auto mode is the default.
		agentAskEveryStep: z.boolean().optional(),
		mcpToolPolicies: z
			.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.enum(MCP_TOOL_POLICIES))
			.refine((p) => Object.keys(p).length <= MAX_MCP_TOOL_POLICIES, {
				message: `At most ${MAX_MCP_TOOL_POLICIES} tool choices`,
			})
			.optional(),
	});
}
