// Operator override panel (reviewers/editors edit prompts + params without a deploy) — see
// $lib/chat/server/tuning.ts for the row shape and its long-term-disposition note (CUR-893).
// Gated by the unified admin login (adminAuth) like the other /admin panels. Unauthenticated
// visitors bounce to the /admin portal (which carries the login form); the shared admin cookie then
// authorizes this page.
import {
	getTuning,
	setTuning,
	clearTuning,
	TuningConflictError,
	type Tuning,
} from "$lib/chat/server/tuning";
import { DEFAULT_PERSONA_TEMPLATE, GROUNDED_DECODING } from "$lib/chat/server/textGeneration/persona";
import { DEFAULT_GROUNDING_TEMPLATE } from "$lib/chat/server/textGeneration/searchGrounding";
import { PANELIST_PREPROMPT, AGGREGATOR_PREPROMPT } from "$lib/chat/server/comparePrompts";
import { CLASSIFIER_PREPROMPT } from "$lib/chat/server/search/searchDecision";
import { shelf } from "$lib/chat/constants/starterShelf";
import { STARTER_COUNT } from "$lib/chat/server/chatShellData";
import { isAdminPermitted, requireAdminPermission, adminActor } from "$lib/chat/server/adminAuth";
import { logAdminActionSafe } from "$lib/chat/server/db/adminAudit";
import { fail, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, cookies }) => {
	// One login for the whole admin area: if not signed in, send them to the portal (which renders
	// the login form). The admin cookie is shared, so logging in there authorizes this page too.
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) {
		redirect(303, `${base}/admin`);
	}
	return {
		current: await getTuning(),
		defaults: {
			persona: DEFAULT_PERSONA_TEMPLATE,
			grounding: DEFAULT_GROUNDING_TEMPLATE,
			decoding: GROUNDED_DECODING,
			starters: shelf,
			panelistPrompt: PANELIST_PREPROMPT,
			aggregatorPrompt: AGGREGATOR_PREPROMPT,
			searchClassifierPrompt: CLASSIFIER_PREPROMPT,
		},
	};
};

function num(v: FormDataEntryValue | null): number | undefined {
	const s = String(v ?? "").trim();
	if (!s) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

// Non-blocking safety net: if an OVERRIDDEN persona/grounding no longer mentions key
// safety markers, warn (never block — the copy owner owns this language and may reword
// deliberately). The hard moderation gate (Coop content/child + in-app injection) is separate
// and not tunable, so this is about the in-conversation guidance only.
function safetyWarnings(t: Tuning): string[] {
	const w: string[] = [];
	if (t.persona) {
		const p = t.persona.toLowerCase();
		if (!/crisis|suicide|988|helpline|findahelpline/.test(p))
			w.push("crisis / self-harm resources");
		if (!/machine|ai system|not a person|non-anthropomorphic/.test(p))
			w.push("the non-anthropomorphic voice rule");
		if (!/\{model\}|\{maker\}|identity|developed by/.test(p)) w.push("model-identity guidance");
	}
	if (t.grounding) {
		const g = t.grounding.toLowerCase();
		if (!/cite|\[1\]|\[n\]|sources/.test(g)) w.push("cite-your-sources grounding");
	}
	return w;
}

// Non-blocking, same reasoning as safetyWarnings: an operator may genuinely want a small fixed
// set (a campaign, a demo), so warn rather than reject. Catches the CUR-620/CUR-893 footgun —
// pickRotatingStarters (starterRotation.ts) short-circuits at pool.length <= count and just
// returns the whole pool unshuffled, so a starters override this small silently freezes what
// every visitor sees instead of rotating it.
function rotationWarning(t: Tuning): string | null {
	const n = t.starters?.length;
	if (!n || n > STARTER_COUNT) return null;
	return `This starters override has only ${n} prompt${n === 1 ? "" : "s"} — rotation needs more than ${STARTER_COUNT} to show anything but the same set every visit.`;
}

// Redacted change summary for the audit log: WHICH groups the operator set — names only, never the
// prompt text/values (privacy: the audit log must not become a second copy of the config).
function tuningChangeSummary(t: Tuning): string {
	const set: string[] = [];
	if (t.persona) set.push("persona");
	if (t.grounding) set.push("grounding");
	if (t.decoding && Object.keys(t.decoding).length) set.push("decoding");
	if (t.starters?.length) set.push("starters");
	if (t.panelistPrompt) set.push("panelistPrompt");
	if (t.aggregatorPrompt) set.push("aggregatorPrompt");
	if (t.searchClassifierPrompt) set.push("searchClassifierPrompt");
	return set.length ? `set: ${set.join(", ")}` : "cleared all fields (revert to defaults)";
}

export const actions: Actions = {
	save: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { tuning: "save" });
		const fd = await request.formData();

		// Build decoding from only the provided number fields (empty = use that default).
		const decoding: NonNullable<Tuning["decoding"]> = {};
		const t = num(fd.get("temperature"));
		if (t !== undefined) decoding.temperature = t;
		const fp = num(fd.get("frequency_penalty"));
		if (fp !== undefined) decoding.frequency_penalty = fp;
		const pp = num(fd.get("presence_penalty"));
		if (pp !== undefined) decoding.presence_penalty = pp;
		const mt = num(fd.get("max_tokens"));
		if (mt !== undefined) decoding.max_tokens = mt;

		// Always include all four groups so blanking a field resets it to the code default
		// ("" / [] / {} are treated as "default" at the read sites). setTuning validates.
		const next: Tuning = {
			persona: String(fd.get("persona") ?? "").trim(),
			grounding: String(fd.get("grounding") ?? "").trim(),
			decoding,
			starters: String(fd.get("starters") ?? "")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean),
			panelistPrompt: String(fd.get("panelistPrompt") ?? "").trim(),
			aggregatorPrompt: String(fd.get("aggregatorPrompt") ?? "").trim(),
			searchClassifierPrompt: String(fd.get("searchClassifierPrompt") ?? "").trim(),
		};

		// Optimistic-concurrency token: the editedAt the editor loaded (empty if there was no row).
		// setTuning rejects the write if the stored row changed since, so two editors can't silently
		// clobber each other (the save is a full-document replace).
		const expectedEditedAt = String(fd.get("expectedEditedAt") ?? "").trim() || undefined;

		try {
			const editor = await adminActor(cookies, locals);
			const saved = await setTuning(next, editor, expectedEditedAt);
			logAdminActionSafe({
				actor: editor,
				action: "tuning.save",
				target: "tuning",
				summary: tuningChangeSummary(next),
				ip: getClientAddress(),
			});
			return {
				saved: true,
				warnings: safetyWarnings(saved),
				rotationWarning: rotationWarning(saved),
				editedAt: saved.editedAt,
			};
		} catch (e) {
			if (e instanceof TuningConflictError) {
				return fail(409, {
					conflict: true,
					conflictBy: e.editedBy ?? "someone",
					conflictAt: e.editedAt ?? "",
				});
			}
			return fail(400, { error: e instanceof Error ? e.message : "save failed" });
		}
	},

	// Wipe ALL overrides + version history back to the code defaults (deletes the TUNING row). A
	// deliberate clean slate — the UI confirms first. Distinct from a blank Save, which keeps history.
	reset: async ({ locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { tuning: "save" });
		try {
			await clearTuning();
			logAdminActionSafe({
				actor: await adminActor(cookies, locals),
				action: "tuning.reset",
				target: "tuning",
				summary: "wiped all overrides + version history to code defaults",
				ip: getClientAddress(),
			});
			return { reset: true };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : "reset failed" });
		}
	},
};
