// Boot-time env validation — the runtime arm of the single source of truth (config/env-manifest.mjs).
// Called from hooks.server.ts init(): if a requiredInProd var is missing/empty the server REFUSES TO
// BOOT (throws), so a misconfigured deploy fails its healthcheck and auto-rolls-back instead of running
// silently wrong. Soft-required vars are logged loudly, not fatal.
import { env as serverEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger } from "$lib/chat/server/logger";
import { requiredKeys, warnKeys } from "../../../../../config/env-manifest.mjs";

export function validateEnv(): void {
	const all: Record<string, string | undefined> = { ...publicEnv, ...serverEnv };
	const present = (k: string) => (all[k] ?? "").trim().length > 0;

	const missingWarn = (warnKeys() as string[]).filter((k) => !present(k));
	if (missingWarn.length) {
		logger.warn(
			{ keys: missingWarn },
			"[env] soft-required vars unset — behaviour degraded (e.g. SOVEREIGN_HOSTS unset → humble serving copy)"
		);
	}

	const missingRequired = (requiredKeys() as string[]).filter((k) => !present(k));
	if (missingRequired.length) {
		const msg = `[env] FATAL: required config vars missing/empty: ${missingRequired.join(", ")}. Refusing to boot — set them or fix config/env-manifest.mjs.`;
		logger.error(msg);
		// Fire-and-forget: this function is sync and the process may not survive long past the throw
		// below, so there's no point awaiting best-effort delivery (CUR-106).
		void captureServerException(new Error(msg));
		throw new Error(msg);
	}
	logger.info(
		`[env] validated ${(requiredKeys() as string[]).length} required + ${(warnKeys() as string[]).length} soft-required vars`
	);
}
