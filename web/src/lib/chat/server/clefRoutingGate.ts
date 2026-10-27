import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: chat. Gates sending the draft to Clef for Auto's model choice. */
export const CLEF_ROUTING_FLAG = "clef-routing";

/** Where Clef is served, read from config. `url` is the base: the model name is the last path segment. */
export interface ClefConfig {
	url: string;
	apiKey: string;
	model: string;
}

/** Clef's config, or undefined when either the address or the key is missing. */
export function clefConfig(): ClefConfig | undefined {
	const url = (config.CLEF_BASE_URL ?? "").trim().replace(/\/+$/, "");
	const apiKey = (config.CLEF_API_KEY ?? "").trim();
	if (!url || !apiKey) return undefined;
	return { url, apiKey, model: (config.CLEF_MODEL ?? "").trim() || "clef" };
}

let warnedMisconfigured = false;

/**
 * Is the hosted Clef read on for this request? Sync, never throws.
 *
 * Off is today's behaviour: Auto reads the draft in the browser only and nothing typed leaves the
 * device before sending. Fallback OFF, so a feature that sends drafts off the device cannot switch
 * itself on when PostHog is unreachable. Only meaningful with `auto-routing` on: without Auto there
 * is no draft reading to refine.
 *
 * The flag decides on/off; CLEF_BASE_URL and CLEF_API_KEY are only where and how to reach it. Flag on
 * with config missing is a misconfiguration: logged once, and the surface withheld.
 */
export function clefRoutingEnabled(): boolean {
	if (!flagEnabledOr(CLEF_ROUTING_FLAG, () => false)) return false;
	if (clefConfig()) return true;
	if (!warnedMisconfigured) {
		warnedMisconfigured = true;
		logger.error(
			{ flag: CLEF_ROUTING_FLAG },
			"[clef] flag is on but CLEF_BASE_URL / CLEF_API_KEY is missing; Auto keeps the local read only"
		);
	}
	return false;
}
