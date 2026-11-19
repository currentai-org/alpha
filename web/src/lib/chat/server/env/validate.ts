// Boot-time env validation — the runtime arm of the single source of truth (config/env-manifest.mjs).
// Called from hooks.server.ts init(): if a requiredInProd var is missing/empty the server REFUSES TO
// BOOT (throws), so a misconfigured deploy fails its healthcheck and auto-rolls-back instead of running
// silently wrong. Soft-required vars are logged loudly, not fatal.
import { env as serverEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { deployEnv, type DeployEnv } from "$lib/chat/server/deployEnv";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";
import { APP_SURFACE, type AppSurface } from "$lib/surface";
import { resolveOpenAiEnv } from "./openWebUiAliases";
import { bootRequiredKeys, bootWarnKeys, surfaceRequiredKeys } from "../../../../../config/env-manifest.mjs";

export function validateEnv(): void {
	validateEnvFor({ ...publicEnv, ...serverEnv }, { surface: APP_SURFACE, deployEnv: deployEnv() });
}

/** `validateEnv` with its inputs passed in, so a spec can drive each surface and environment. */
export function validateEnvFor(
	all: Record<string, string | undefined>,
	where: { surface: AppSurface; deployEnv: DeployEnv | null }
): void {
	const required = bootRequiredKeys(where) as string[];
	const warned = bootWarnKeys(where) as string[];
	// config.ts maps Open WebUI's OPENAI_API_BASE_URLS onto OPENAI_BASE_URL; check what it will serve, not the raw name.
	const owui = resolveOpenAiEnv(all);
	if (owui.source === "open-webui") all = { ...all, OPENAI_BASE_URL: owui.baseUrl };
	const present = (k: string) => (all[k] ?? "").trim().length > 0;

	const missingWarn = warned.filter((k) => !present(k));
	if (missingWarn.length) {
		logger.warn(
			{ keys: missingWarn },
			"[env] soft-required vars unset — behaviour degraded (e.g. SOVEREIGN_HOSTS unset → humble serving copy)"
		);
	}

	// Required somewhere, waived here: say so, so a site deployment that lost its environment label
	// and booted without the CMS is still visible in the boot log.
	// A site-only build drops chat's keys by design, so only the keys its surface reads count.
	const waivedMissing = (surfaceRequiredKeys(where) as string[]).filter((k) => !required.includes(k) && !present(k));
	if (waivedMissing.length) {
		logger.warn(
			{ keys: waivedMissing, surface: where.surface, deployEnv: where.deployEnv },
			"[env] required-in-production vars unset, not fatal on this surface/environment — the features that read them are off"
		);
	}

	const missingRequired = required.filter((k) => !present(k));
	if (missingRequired.length) {
		const msg = `[env] FATAL: required config vars missing/empty: ${missingRequired.join(", ")}. Refusing to boot — set them or fix config/env-manifest.mjs.`;
		logger.error(msg);
		// Fire-and-forget: this function is sync and the process may not survive long past the throw
		// below, so there's no point awaiting best-effort delivery.
		void captureServerException(new Error(msg));
		throw new Error(msg);
	}
	logger.info(
		{ surface: where.surface, deployEnv: where.deployEnv },
		`[env] validated ${required.length} required + ${warned.length} soft-required vars`
	);
}
