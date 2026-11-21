// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { config, ready } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { dev } from "$app/environment";
import { initExitHandler, onExit } from "$lib/chat/server/exitHandler";
import { startProcessKeepalive } from "$lib/chat/server/keepalive";
import { AbortedGenerations } from "$lib/chat/server/abortedGenerations";
import { adminTokenManager } from "$lib/chat/server/adminToken";
import { MetricsServer } from "$lib/chat/server/metrics";
import { firstKey } from "$lib/chat/server/env/firstKey";

export async function initServer(): Promise<void> {
	// Wait for config to be fully loaded
	await ready;

	// Ensure legacy env expected by some libs: map OPENAI_API_KEY -> HF_TOKEN if absent.
	// `??=` would skip this when HF_TOKEN is "" rather than undefined — the manifest declares
	// it, so a local `pnpm dev` off the unstripped .env scaffold sees exactly that.
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
	// The safety screen's posture goes in the boot log, so a self-host without Coop says so at start
	// and a hosted deployment that lost its Coop config errors before the first turn.
	(await import("$lib/chat/server/moderation")).logCoopPostureAtBoot();
	// A self-host edition with no safety classifier says so at boot: its turns answer unscreened.
	(await import("$lib/chat/server/guardGate")).logGuardPostureAtBoot();
	// Each self-host feature left off for want of a setting is named in the boot log.
	(await import("$lib/chat/server/flags")).logSelfHostFlagPostureAtBoot();
	initExitHandler();

	if (config.METRICS_ENABLED === "true") {
		MetricsServer.getInstance();
	}

	// Init AbortedGenerations refresh process
	AbortedGenerations.getInstance();

	// Off Vercel, this process keeps its own flags, registry and DB connection fresh.
	if (!dev) {
		const stop = startProcessKeepalive({
			tick: async () => (await import("$lib/chat/server/warm")).warmProcess(),
		});
		if (stop) onExit(stop);
	}

	adminTokenManager.displayToken();

	if (config.EXPOSE_API) {
		logger.warn(
			"The EXPOSE_API flag has been deprecated. The API is now required for chat-ui to work."
		);
	}
}
