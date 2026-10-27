// PROMPT-RESTRICTED SyftHub routing (demo / controlled mode).
//
// When SYFTHUB_PROMPT_ROUTING=on, the federated SyftHub store fires ONLY on the prompts configured in
// ./syftPrompts.json, and ONLY against the `owner/slug` data stores attached to the matched rule — the
// whole discovery stack (catalog pre-gate, LLM router, embedding discovery, pick gate) is bypassed, so
// the attached stores are ALWAYS consulted. Every other prompt gets NO SyftHub at all. When the flag is
// off (default) this module is inert and today's discovery-driven behavior is unchanged.
//
// Matching is EXACT after normalization: the `prompt` IS the trigger, and a rule fires only when the
// query EQUALS that prompt once both are normalized (lowercased, punctuation stripped, whitespace
// collapsed). No fuzzy/partial/coverage matching — a wrapper, extra words, or a typo do NOT fire. This is
// deliberately strict so prompt-only mode can never touch SyftHub on anything but a configured prompt.
// Endpoints from ALL matching rules are unioned (de-duplicated) in case two rules share a normalized
// prompt. Fail-open: malformed config, no rules, or no match ⇒ [], never a throw.

import rawConfig from "./syftPrompts.json";
import { logger } from "$lib/chat/server/logger";

export type SyftPromptRule = {
	/** The normalized trigger text — the query must equal this (after normalization) for the rule to fire. */
	prompt: string;
	/** `owner/slug` data-source paths queried directly when this rule matches. */
	endpoints: string[];
};

/** Lowercase, strip ALL punctuation to spaces (so quotes / dashes / trailing "?" don't break equality),
 *  collapse whitespace. Applied identically to the configured prompts (at load) and the live query. */
export function normalizePrompt(s: string): string {
	return (s ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ") // any non-alphanumeric (punctuation, quotes, dashes, …) → space
		.replace(/\s+/g, " ")
		.trim();
}

/** A well-formed SyftHub data-source path: exactly one `/`, no whitespace, non-empty owner + slug. */
export function isSyftEndpointPath(p: unknown): p is string {
	return typeof p === "string" && /^[^\s/]+\/[^\s/]+$/.test(p.trim());
}

/** Parse + validate the committed config ONCE at module load. Drops malformed rules (with a warn) so a
 *  typo in one rule can never take the whole feature down. */
const RULES: SyftPromptRule[] = ((): SyftPromptRule[] => {
	const raw = (rawConfig as { rules?: unknown })?.rules;
	if (!Array.isArray(raw)) {
		logger.warn("[rag] syftPrompts.json has no `rules` array — prompt-routed SyftHub is inert");
		return [];
	}
	const rules: SyftPromptRule[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") {
			continue;
		}
		const rec = r as Record<string, unknown>;
		const prompt = typeof rec.prompt === "string" ? normalizePrompt(rec.prompt) : "";
		const endpoints = Array.isArray(rec.endpoints)
			? rec.endpoints.filter(isSyftEndpointPath).map((e) => e.trim())
			: [];
		if (!prompt || endpoints.length === 0) {
			logger.warn(
				{ prompt: rec.prompt },
				"[rag] syftPrompts.json rule ignored — needs a non-empty `prompt` and valid `endpoints`"
			);
			continue;
		}
		rules.push({ prompt, endpoints });
	}
	return rules;
})();

/** The validated rules (read-only) — for tests / diagnostics. */
export function syftPromptRules(): readonly SyftPromptRule[] {
	return RULES;
}

/** Endpoints of every rule whose configured prompt EQUALS the query after normalization, unioned and
 *  de-duplicated. Empty array ⇒ no configured prompt matched ⇒ the caller must NOT run the federated
 *  store this turn. Exact match only — no wrapper, extra words, or typo fires. */
export function matchSyftPromptEndpoints(query: string | undefined): string[] {
	const q = normalizePrompt(query ?? "");
	if (!q) {
		return [];
	}
	const out: string[] = [];
	for (const rule of RULES) {
		if (rule.prompt === q) {
			for (const e of rule.endpoints) {
				if (!out.includes(e)) {
					out.push(e);
				}
			}
		}
	}
	return out;
}
