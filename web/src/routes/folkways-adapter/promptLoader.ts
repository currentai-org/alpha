// Folkways adapter — the stable-prompt loader (demo plan 5.4-5.6).
//
// This is the SECOND deliberate chat-lib read the adapter makes (the first is
// safetySnapshot.ts). It calls `getTuning()` and a handful of host BUILDER functions/constants
// to produce the seven "stable" prompt segments the `prompts` host report carries. All
// of these reads are at REPORT time (once per changed hash, throttled by the caller), never per
// chat message — the assembled per-turn system message is a SEPARATE, smaller thing handled by
// layerDetection.ts, and this file never touches it.
//
// Per the adapter's own hard rule ("imports no Folkways core modules — it copies the wire
// types", writing-an-adapter.md #1), the segment/report shapes below are a local copy of
// core/src/contracts.ts's `promptReportSegmentSchema` / `promptsHostReportPayloadSchema`. Keep
// the two in sync by hand; a shape drift here is caught at the control plane as a 400 on
// POST /v1/host-reports, not by a shared import.
//
// Segment sources (file + export), one for one with demo plan 5.5:
//   persona            textGeneration/persona.ts        buildPersonaPrompt() + DEFAULT_PERSONA_TEMPLATE
//   grounding          textGeneration/searchGrounding.ts DEFAULT_GROUNDING_TEMPLATE (the raw instruction
//                                                         template — {asOf}/{evidence} left UNFILLED; the
//                                                         adapter never has real evidence to fill them
//                                                         with, and it must not synthesize any)
//   panelist           comparePrompts.ts                 PANELIST_PREPROMPT
//   aggregator         comparePrompts.ts                 AGGREGATOR_PREPROMPT
//   search-classifier  search/classifierPrompt.ts        CLASSIFIER_PREPROMPT (imported from the pure
//                                                         module, not search/searchDecision.ts, so this
//                                                         report-time read carries none of that file's
//                                                         HTTP-lane/billing-header side effects)
//   model-preprompt    server/models.ts                  defaultModel.preprompt (no tuning override exists
//                                                         for this segment; override is always null)
//   decoding           textGeneration/persona.ts         GROUNDED_DECODING + resolveDecoding() (JSON text,
//                                                         not a prompt — the panel changes it, so it rides
//                                                         in the same report; see demo plan 5.5)
//
// getTuning() is the ONE second source of truth (tuning.ts's own header note, CUR-620/893): the
// database TUNING row can differ from the code default at any time, without a deploy. Each
// segment below reports BOTH texts and says which one is active, so the console can show the
// drift instead of hiding it.
//
// Two more host facts the control plane now accepts on the `prompts` report, alongside the seven
// segments (not segments themselves, so they get their own small resolvers rather than a place in
// PROMPT_SEGMENT_IDS): resolveModelAllowlist() — the host's live model allowlist, sourced from the
// registered `models[]` list — and resolveModelParameters() — the resolved decoding defaults for
// the default model, the same values the `decoding` segment already serializes.
import { createHash } from 'node:crypto';
import { getTuning } from '$lib/chat/server/tuning';
import { defaultModel, models } from '$lib/chat/server/models';
import {
	buildPersonaPrompt,
	GROUNDED_DECODING,
	resolveDecoding
} from '$lib/chat/server/textGeneration/persona';
import { DEFAULT_GROUNDING_TEMPLATE } from '$lib/chat/server/textGeneration/searchGrounding';
import { PANELIST_PREPROMPT, AGGREGATOR_PREPROMPT } from '$lib/chat/server/comparePrompts';
import { CLASSIFIER_PREPROMPT } from '$lib/chat/server/search/classifierPrompt';

// Local copy of core/src/contracts.ts's promptSegmentIdSchema enum. ORDER MATTERS: it is the
// deterministic concatenation order for the stable hash (see stablePromptHash below), and it
// must match the control plane's own enum order so a console diff reads sensibly.
export const PROMPT_SEGMENT_IDS = [
	'persona',
	'grounding',
	'panelist',
	'aggregator',
	'search-classifier',
	'model-preprompt',
	'decoding'
] as const;
export type PromptSegmentId = (typeof PROMPT_SEGMENT_IDS)[number];

export type PromptReportSegment = {
	id: PromptSegmentId;
	code_default: string;
	override: string | null;
	active_source: 'code' | 'database';
	override_editor?: string;
	override_edited_at?: string;
};

/** Build one segment from a code default and a raw tuning override (already resolved to the
 *  full text the console should show — for persona this means run back through
 *  buildPersonaPrompt so identity tokens are filled the same way the code default is; for
 *  everything else the raw override text already IS the full segment text). Only stamps
 *  editor/time when the tuning row actually carries them (5.4: an old or hand-written row may
 *  not). */
function segment(
	id: PromptSegmentId,
	codeDefault: string,
	rawOverride: string | undefined,
	editedBy: string | undefined,
	editedAt: string | undefined,
	renderOverride: (raw: string) => string = (raw) => raw
): PromptReportSegment {
	const trimmed = rawOverride?.trim();
	if (!trimmed) {
		return { id, code_default: codeDefault, override: null, active_source: 'code' };
	}
	const out: PromptReportSegment = {
		id,
		code_default: codeDefault,
		override: renderOverride(trimmed),
		active_source: 'database'
	};
	if (editedBy) out.override_editor = editedBy;
	if (editedAt) out.override_edited_at = editedAt;
	return out;
}

/** The seven stable segments, as the host would build/serve them right now. Report-time only —
 *  see the file header. Never throws: a host-side read failure here must not block a chat
 *  request (the caller wraps this the same way safetySnapshot() is wrapped), but it IS allowed
 *  to throw, since the only caller already wraps it in try/catch. */
export async function loadStablePromptSegments(): Promise<PromptReportSegment[]> {
	const tuning = await getTuning();
	const editedBy = tuning.editedBy;
	const editedAt = tuning.editedAt;

	// 5.6: persona is built "as served on a plain turn" — the default model, grounded=false. Both
	// the code-default and (when present) the override text are rendered through the SAME
	// builder so identity tokens ({model}/{maker}/...) are filled identically in both, and the
	// override's `active_source: 'database'` text is exactly what a plain turn would see today.
	const modelId = defaultModel?.id ?? defaultModel?.name;
	const personaCodeDefault = buildPersonaPrompt(modelId, undefined, { grounded: false });
	const personaSegment = segment(
		'persona',
		personaCodeDefault,
		tuning.persona,
		editedBy,
		editedAt,
		(raw) => buildPersonaPrompt(modelId, raw, { grounded: false })
	);

	// Grounding: the raw instruction TEMPLATE, {asOf}/{evidence} tokens left unfilled. Filling
	// them needs a real search turn's evidence, which the adapter must never carry (5.5).
	const groundingSegment = segment(
		'grounding',
		DEFAULT_GROUNDING_TEMPLATE,
		tuning.grounding,
		editedBy,
		editedAt
	);

	const panelistSegment = segment(
		'panelist',
		PANELIST_PREPROMPT,
		tuning.panelistPrompt,
		editedBy,
		editedAt
	);

	const aggregatorSegment = segment(
		'aggregator',
		AGGREGATOR_PREPROMPT,
		tuning.aggregatorPrompt,
		editedBy,
		editedAt
	);

	const searchClassifierSegment = segment(
		'search-classifier',
		CLASSIFIER_PREPROMPT,
		tuning.searchClassifierPrompt,
		editedBy,
		editedAt
	);

	// No tuning override exists for the model preprompt (server/models.ts, MODELS env / prepromptUrl
	// only) — always "code".
	const modelPrepromptSegment: PromptReportSegment = {
		id: 'model-preprompt',
		code_default: defaultModel?.preprompt ?? '',
		override: null,
		active_source: 'code'
	};

	// Not a prompt, but the tuning panel edits it alongside the prompts, so the console shows it
	// in the same place. JSON text, both sides run through resolveDecoding() so the
	// override text is the MERGED result (override keys win, unset keys keep the code default) —
	// exactly what generate() actually sends.
	const decodingOverrideRaw =
		tuning.decoding && Object.keys(tuning.decoding).length > 0 ? tuning.decoding : undefined;
	const decodingSegment: PromptReportSegment = {
		id: 'decoding',
		code_default: JSON.stringify(GROUNDED_DECODING),
		override: decodingOverrideRaw ? JSON.stringify(resolveDecoding(decodingOverrideRaw)) : null,
		active_source: decodingOverrideRaw ? 'database' : 'code'
	};
	if (decodingOverrideRaw) {
		if (editedBy) decodingSegment.override_editor = editedBy;
		if (editedAt) decodingSegment.override_edited_at = editedAt;
	}

	return [
		personaSegment,
		groundingSegment,
		panelistSegment,
		aggregatorSegment,
		searchClassifierSegment,
		modelPrepromptSegment,
		decodingSegment
	];
}

/** The host's live model allowlist, for the `prompts` host report's optional `model_allowlist`
 *  field. Sourced from `models[]` (server/models.ts) — the ids of the REGISTERED model list, i.e.
 *  the post-catalog-validation, post-override, post-MODEL_ALLOWLIST-parse set the host will
 *  actually attempt to serve right now — rather than the raw MODEL_ALLOWLIST env string, which can
 *  name an id the upstream catalog doesn't actually offer (it would then be silently dropped by
 *  selectAllowedModels and never reach `models[]`). Never empty: falls back to `[hostModelId]` on
 *  the practically-impossible case that the registry is empty (ensureModelsReady already refuses
 *  requests before that can happen in production). */
export function resolveModelAllowlist(hostModelId: string): string[] {
	const ids = [
		...new Set(models.map((m) => m.id).filter((id): id is string => Boolean(id?.trim())))
	];
	return ids.length > 0 ? ids : [hostModelId];
}

/** The resolved decoding defaults for the default model, for the `prompts` host report's optional
 *  `model_parameters` field — exactly the values the `decoding` segment's ACTIVE text already
 *  serializes (GROUNDED_DECODING with any tuning override merged over it, see resolveDecoding). */
export async function resolveModelParameters(): Promise<Record<string, unknown>> {
	const tuning = await getTuning();
	return resolveDecoding(tuning.decoding);
}

/** The text a console reader would see as ACTIVE for a segment right now: the override when one
 *  is set, else the code default. */
function activeText(s: PromptReportSegment): string {
	return s.active_source === 'database' ? (s.override ?? s.code_default) : s.code_default;
}

/** sha256 over the active text of all seven segments, concatenated in the fixed
 *  PROMPT_SEGMENT_IDS order with a delimiter that can't appear inside a segment id (so this is
 *  stable and deterministic regardless of object key order). Changes exactly when what the host
 *  would actually serve changes — a tuning edit, a code deploy that changes a template/decoding
 *  default, or a default-model swap. */
export function stablePromptHash(segments: PromptReportSegment[]): string {
	const byId = new Map(segments.map((s) => [s.id, s]));
	const material = PROMPT_SEGMENT_IDS.map((id) => {
		const s = byId.get(id);
		return `${id} ${s ? activeText(s) : ''}`;
	}).join('');
	return createHash('sha256').update(material).digest('hex');
}
