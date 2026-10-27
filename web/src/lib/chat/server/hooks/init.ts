import { config, ready } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { initExitHandler } from "$lib/chat/server/exitHandler";
import { AbortedGenerations } from "$lib/chat/server/abortedGenerations";
import { MetricsServer } from "$lib/chat/server/metrics";
import { firstKey } from "$lib/chat/server/env/firstKey";

export async function initServer(): Promise<void> {
	// Wait for config to be fully loaded
	await ready;

	// Ensure legacy env expected by some libs: map OPENAI_API_KEY -> HF_TOKEN if absent.
	// `??=` would skip this when HF_TOKEN is "" rather than undefined — the manifest declares
	// it, so a local `pnpm dev` off the unstripped .env scaffold sees exactly that (CUR-142).
	// This boot path runs outside both the vitest and vite-node strips, so the fix has to be
	// here rather than upstream.
	const canonicalToken = firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "canonicalToken");
	if (canonicalToken && !process.env.HF_TOKEN) {
		process.env.HF_TOKEN = canonicalToken;
	}

	// Warn if legacy-only var is used
	if (!config.OPENAI_API_KEY && config.HF_TOKEN) {
		logger.warn(
			"HF_TOKEN is deprecated in favor of OPENAI_API_KEY. Please migrate to OPENAI_API_KEY."
		);
	}

	logger.info("Starting server...");
	initExitHandler();

	if (config.METRICS_ENABLED === "true") {
		MetricsServer.getInstance();
	}

	// Init AbortedGenerations refresh process
	AbortedGenerations.getInstance();

	if (config.EXPOSE_API) {
		logger.warn(
			"The EXPOSE_API flag has been deprecated. The API is now required for chat-ui to work."
		);
	}
}
