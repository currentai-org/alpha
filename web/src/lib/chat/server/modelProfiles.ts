// What each (model, provider) pair accepts on the wire, read from the rows `scripts/model-profile-probe.mjs`
// measured and wrote to modelProfiles.verified.json (CUR-2113). Providers serving the same open model
// disagree on how reasoning is turned off, which `reasoning_effort` values they take, and whether a
// system role or a forced tool call is honoured; a table keyed by provider alone (CUR-2090's first
// shape) was wrong for every provider that serves two models differently. Every caller that builds a
// request body asks this module rather than carrying its own copy of a provider's quirks.

import { flattensRolesUnprobed } from "./harnessProfiles";
import verified from "./modelProfiles.verified.json";

export type Effort = "none" | "minimal" | "low" | "medium" | "high";

interface ProviderProfile {
	/** The one field that turns reasoning off, as a dotted path; null when the probe found no switch. */
	reasoningOff: { path: string; value: unknown } | null;
	/** `reasoning_effort` values the provider answered 200 to. */
	efforts: string[];
	/** `reasoning_effort: "none"` is answered with a 400 (gpt-oss has no off switch). */
	effortNoneRejected: boolean;
	/** null: the probe could not tell (the provider refused the call for another reason). */
	systemRoleSupported: boolean | null;
	reasoningFormat: "field" | "none";
	/** A forced `tool_choice` comes back as that tool call. */
	tools: boolean;
	verifiedAt: string;
	n: number;
}

const PROFILES = verified as unknown as Readonly<
	Record<string, Readonly<Record<string, ProviderProfile>>>
>;

export { HF_PROVIDER_PIN } from "./hfProviderPin";

/** The verified row for one model on one provider, or undefined when nothing was measured. */
function profileFor(
	modelId: string,
	provider: string | undefined
): ProviderProfile | undefined {
	if (!provider) return undefined;
	return PROFILES[modelId.trim().toLowerCase()]?.[provider.trim().toLowerCase()];
}

/** Every verified row for a model, whichever provider served it. */
function profilesForModel(modelId: string): ProviderProfile[] {
	return Object.values(PROFILES[modelId.trim().toLowerCase()] ?? {});
}

/** Split a wire id into the model and its `:provider` suffix, if it carries one. */
export function splitWireId(wireId: string): { model: string; provider: string | undefined } {
	const at = wireId.lastIndexOf(":");
	if (at < 0) return { model: wireId, provider: undefined };
	return { model: wireId.slice(0, at), provider: wireId.slice(at + 1).toLowerCase() || undefined };
}

/** The profile key for a host that is not the HF router: the probe records those as `gateway:<host>`. */
function gatewayProvider(baseURL: string | undefined): string | undefined {
	try {
		const host = new URL(baseURL ?? "").hostname.toLowerCase().replace(/\.$/, "");
		return host ? `gateway:${host}` : undefined;
	} catch {
		return undefined;
	}
}

/** `{path: "thinking.type", value: "disabled"}` → `{thinking: {type: "disabled"}}`. */
function fieldsAt(path: string, value: unknown): Record<string, unknown> {
	const keys = path.split(".");
	return keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<
		string,
		unknown
	>;
}

/**
 * The fields that turn reasoning off for this pair. A verified row decides, including a row with no
 * switch, which yields no fields. With no row, `thinking: disabled` is sent: it is what zai-org and
 * novita honour, and every other provider measured so far ignores it rather than refusing it.
 */
export function reasoningOffFields(
	modelId: string,
	provider: string | undefined
): Record<string, unknown> {
	const profile = profileFor(modelId, provider);
	if (!profile) return { thinking: { type: "disabled" } };
	return profile.reasoningOff ? fieldsAt(profile.reasoningOff.path, profile.reasoningOff.value) : {};
}

/**
 * The reasoning-off fields a verified row gives for this wire id on this host, and nothing otherwise:
 * no `thinking` guess. For non-streaming side calls on a model that reasons by default. Mistral Large 4
 * through the staging router is the case (CUR-4281): unstreamed, it answers in typed `thinking`/`text`
 * parts the router cannot parse, so the router retries for ~45 s and answers from its backup model
 * instead; with `reasoning_effort: "none"` it answers as Large 4 in about a second. A `thinking:
 * disabled` field the router does not accept stalls the call, so an unmeasured pair gets no field.
 */
export function measuredReasoningOff(
	wireModelId: string,
	baseURL: string | undefined
): Record<string, unknown> {
	const { model, provider } = splitWireId(wireModelId);
	const profile = profileFor(model, provider) ?? profileFor(model, gatewayProvider(baseURL));
	return profile?.reasoningOff ? fieldsAt(profile.reasoningOff.path, profile.reasoningOff.value) : {};
}

/**
 * Whether the user's answer to this model must go out as one flattened user message, and so whether
 * native-first's hedged retry has anything to fall back to (CUR-2145). The workaround exists for
 * Apertus deployments that refuse the system and assistant roles (CUR-1294); a model every measured
 * lane serves with roles gets its request once, in its real shape.
 *
 * A model with any row that is false or could not be told (null) is flattened: Apertus 70B stays
 * flattened through its featherless-ai row. The gateway pools deployments behind one host, so a
 * gateway call is judged on every row for the model rather than on the host's own row.
 *
 * A model nobody has measured is flattened only if its harness row says so (`flattenRolesUnprobed`,
 * harnessProfiles.ts), which every Apertus row does: its unprobed variants (the `-thinking` build,
 * the 1.0 8B) can land on the same refusing hosts. Every other unmeasured model (Sea-Lion, ALIA,
 * Bielik on the gateway) is sent its real roles, and a verified row is how one that turns out to need
 * flattening gets it.
 */
export function rolesNeedFlattening(modelId: string): boolean {
	const model = splitWireId(modelId).model;
	const rows = profilesForModel(model);
	if (rows.length === 0) return flattensRolesUnprobed(model);
	return rows.some((r) => r.systemRoleSupported !== true);
}

const EFFORT_ORDER: readonly Effort[] = ["none", "minimal", "low", "medium", "high"];

/**
 * The `reasoning_effort` to send for `wanted`, given what the serving pair accepts. A caller asking
 * for "none" on a model that rejects it gets the lowest effort the model does accept, instead of a
 * 400: gpt-oss-120b has no off switch and refuses "none" (CUR-2113). With no provider on the wire id
 * the router picks one, so the rows for every measured provider are consulted and "none" is replaced
 * only when all of them reject it. A model with no rows gets `wanted` unchanged.
 */
export function acceptedEffort(
	wireModelId: string,
	baseURL: string | undefined,
	wanted: Effort | undefined
): Effort | undefined {
	if (!wanted) return wanted;
	const { model, provider } = splitWireId(wireModelId);
	const pinned = profileFor(model, provider) ?? profileFor(model, gatewayProvider(baseURL));
	const rows = pinned ? [pinned] : profilesForModel(model);
	if (rows.length === 0) return wanted;
	if (rows.some((r) => r.efforts.includes(wanted))) return wanted;
	if (wanted === "none" && !rows.every((r) => r.effortNoneRejected)) return wanted;
	const accepted = EFFORT_ORDER.filter((e) => rows.every((r) => r.efforts.includes(e)));
	const above = accepted.find((e) => EFFORT_ORDER.indexOf(e) >= EFFORT_ORDER.indexOf(wanted));
	return above ?? accepted[0] ?? wanted;
}
