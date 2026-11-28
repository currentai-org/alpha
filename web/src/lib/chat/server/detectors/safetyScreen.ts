// detectors/safetyScreen — which detector screens chat text (SAFETY_SCREEN), and the one JudgeFn the
// gate calls for it. One path per value, no fallback from one detector to another:
//   shieldstral      detectors/shieldstral.ts answers every rule.
//   qwen3guard       detectors/qwen3guard.ts answers 13 rules from one call per unit; Shieldstral answers
//                    SHIELDSTRAL_PAIRED_RULES, and every rule of a picture.
//   qwen3guard-only  qwen3guard.ts alone. A picture is unknown.
// The default is committed config keyed by edition (web/config/safetyScreen.ts); SAFETY_SCREEN overrides
// it. An unrecognised value is an error, never a quiet default.
import {
	SAFETY_SCREENS,
	SAFETY_SCREEN_DEFAULT,
	SHIELDSTRAL_PAIRED_RULES,
	type SafetyScreen,
} from "../../../../../config/safetyScreen";
import { selfHostEdition } from "$lib/chat/server/edition";
import { loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import type { JudgeFn } from "$lib/chat/server/guardScreenTypes";
import { makeQwen3GuardJudge, QWEN3GUARD_MODEL, qwen3guardConfigured } from "./qwen3guard";
import { SHIELDSTRAL_MODEL, shieldstralConfigured, shieldstralJudge } from "./shieldstral";

/** The screen for a SAFETY_SCREEN value and an edition. Pure, so the default is testable. */
export function resolveSafetyScreen(value: string | undefined, selfHost: boolean): SafetyScreen {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "") return SAFETY_SCREEN_DEFAULT[selfHost ? "selfhost" : "hosted"];
	if ((SAFETY_SCREENS as readonly string[]).includes(v)) return v as SafetyScreen;
	throw new Error(`SAFETY_SCREEN="${value}" is not one of ${SAFETY_SCREENS.join(", ")}`);
}

/** This process's screen. Throws on an unrecognised SAFETY_SCREEN. */
export function safetyScreen(): SafetyScreen {
	return resolveSafetyScreen(process.env.SAFETY_SCREEN, selfHostEdition());
}

/** Is the screen's endpoint set? shieldstral and the pair need GUARD_SHADOW_URL (the Shieldstral base,
 *  the name is historical); the pair and qwen3guard-only also need QWEN3GUARD_URL. A bad SAFETY_SCREEN
 *  counts as configured, so the judge's unknown answers and the boot log say why instead of a silent off. */
export function safetyScreenConfigured(): boolean {
	let s: SafetyScreen;
	try {
		s = safetyScreen();
	} catch {
		return true;
	}
	if (s === "shieldstral") return shieldstralConfigured();
	if (s === "qwen3guard-only") return qwen3guardConfigured();
	return shieldstralConfigured() && qwen3guardConfigured();
}

/** The served-model ids the health probe accepts for this screen. */
export function safetyScreenModels(): string[] {
	try {
		const s = safetyScreen();
		if (s === "shieldstral") return [SHIELDSTRAL_MODEL];
		return s === "qwen3guard-only" ? [QWEN3GUARD_MODEL] : [QWEN3GUARD_MODEL, SHIELDSTRAL_MODEL];
	} catch {
		return [SHIELDSTRAL_MODEL];
	}
}

const qwen3guardJudge = makeQwen3GuardJudge();
const PAIRED = new Set<string>(SHIELDSTRAL_PAIRED_RULES);
let keyByQuery: Map<string, string> | undefined;

/** The gate's default judge: dispatches on SAFETY_SCREEN at call time. */
export const screenJudge: JudgeFn = async (target, query, threshold, ctx) => {
	let s: SafetyScreen;
	try {
		s = safetyScreen();
	} catch (e) {
		ctx.log.error({ gateSource: "guard" }, `[guard] ${(e as Error).message} — screening UNKNOWN until it is fixed`);
		return { answer: { kind: "unknown" }, httpOk: false };
	}
	if (s === "shieldstral") return shieldstralJudge(target, query, threshold, ctx);
	if (s === "qwen3guard-only") return qwen3guardJudge(target, query, threshold, ctx);
	if (target.kind === "image") return shieldstralJudge(target, query, threshold, ctx);
	keyByQuery ??= new Map((loadGuardPolicy()?.entries ?? []).map((r) => [r.query, r.key]));
	const key = keyByQuery.get(query);
	return key && PAIRED.has(key)
		? shieldstralJudge(target, query, threshold, ctx)
		: qwen3guardJudge(target, query, threshold, ctx);
};
