/**
 * Shared by the two settings write surfaces (`api/v2/user/settings/+server.ts` and the legacy
 * `settings/(nav)/+server.ts`) — they validate and persist a settings PATCH identically; only their
 * route-handler shells (typed `RequestHandler` + `requireAuth` + a sibling GET, vs. a bare untyped
 * `POST`) differ. One shared body (CUR-1194) so a fix cannot land on one copy and not the other,
 * the risk class `audit:dup:check` exists to catch.
 *
 * The `activeModel` schema itself is `settingsSchema()` (settingsSchema.ts), which `.catch()`-coerces
 * an unregistered id to the default rather than failing the whole write. `settingsSchema()` takes the
 * per-user `activeModelSchema` this feature needs (a local model never appears in the bare global
 * registry `settingsSchema()` defaults to), so both behaviours apply together.
 */
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { config } from "$lib/chat/server/config";
import { getEffectiveValidModelIdSchema, prewarmLocalModelForUser } from "$lib/chat/server/localModels";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { settingsSchema } from "$lib/chat/server/settingsSchema";
import { type SettingsEditable } from "$lib/chat/types/Settings";
import { resolveStreamingMode } from "$lib/chat/utils/messageUpdates";

/** Validate `body` against this user's effective schema and persist the fields it names. Throws (a
 *  ZodError) on an invalid body — both callers let that propagate to SvelteKit's default error
 *  handling.
 *
 *  Why (CUR-1643): the schema fills a default for every absent field, so persisting the whole parse
 *  would write `smooth` back over a saved `raw` whenever a body omitted `streamingMode`. Only the keys
 *  the body actually sent reach `$set`; the rest of the row is untouched.
 *  That is what lets two tabs, or the welcome dialog's dismissal, save one field without reverting
 *  another tab's choice. */
export async function applySettingsUpdate(locals: App.Locals, body: unknown): Promise<void> {
	const sent = new Set(body && typeof body === "object" ? Object.keys(body) : []);
	const { welcomeModalSeen, ...validated } = settingsSchema(
		await getEffectiveValidModelIdSchema(locals)
	).parse(body);
	const parsedSettings: Partial<typeof validated> = Object.fromEntries(
		Object.entries(validated).filter(([key]) => sent.has(key))
	);

	// Best-effort only (CUR-1194): give a cold local instance a head start the moment it's activated.
	// No-ops instantly for any non-local model. Routed through runInBackground, not a bare `void` — see
	// conversation/[id]/+server.ts's PATCH handler for why a fire-and-forget promise alone would
	// silently no-op on Vercel.
	void runInBackground(prewarmLocalModelForUser(locals, parsedSettings.activeModel));

	if (config.isHuggingChat) {
		parsedSettings.multimodalOverrides = {};
		parsedSettings.reasoningOverrides = {};
	}

	// A key sent as `null` is a reset. It leaves the row rather than being stored as null, so
	// a later read sees `undefined`, the one shape answerPreferences.ts treats as "Alpha's default". (CUR-3929)
	const unset = Object.fromEntries(
		Object.entries(parsedSettings)
			.filter(([, value]) => value === null)
			.map(([key]) => [key, true])
	);
	const kept = Object.fromEntries(
		Object.entries(parsedSettings).filter(([, value]) => value !== null)
	) as { [K in keyof typeof parsedSettings]: Exclude<(typeof parsedSettings)[K], null> };

	const settings = {
		...kept,
		...(sent.has("streamingMode") && { streamingMode: resolveStreamingMode(kept) }),
	} satisfies Partial<SettingsEditable>;

	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				...settings,
				...(welcomeModalSeen && { welcomeModalSeenAt: new Date() }),
				updatedAt: new Date(),
			},
			...(Object.keys(unset).length && { $unset: unset }),
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{ upsert: true }
	);
}
