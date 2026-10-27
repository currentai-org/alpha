// The picker's model list and its first entry, the primary served model. Lives in this tiny leaf module
// (config-only imports) so models.ts, the warmup path (warm.ts) and the SyftHub pre-flight router
// (rag/syftRouter.ts) all resolve it the same way WITHOUT dragging in warm.ts's heavier static graph
// (moderation + the embeddings client), which would break the hermetic router/catalog unit tests.

import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { deploymentInstance } from "$lib/chat/server/instance";
import { PICKER, deployedEnv, pickerSite } from "../../../../config/inference";

let warnedOverride = false;

/**
 * The picker's comma-separated model list, before the ticket-branch reorder in models.ts.
 *
 * On a deployment (DEPLOY_ENV or VERCEL_ENV production or preview) it is config/inference.ts's list for this site (CUR-3484), so what www
 * offers is reviewed in a PR rather than typed into Doppler. A MODEL_ALLOWLIST still set there is
 * ignored and logged once when it differs. Off Vercel (local dev, CI, evals, specs) it is
 * MODEL_ALLOWLIST as before, which is how evals pin one model, and empty when that is unset.
 */
export function pickerSpec(env: NodeJS.ProcessEnv = process.env): string {
	const override = ((Reflect.get(config, "MODEL_ALLOWLIST") as string | undefined) ?? "").trim();
	// Taken from `env` so a spec can pass one.
	const deployed = deployedEnv(env);
	if (!deployed) return override;
	const spec = PICKER[pickerSite(deployed, deploymentInstance(env))].join(",");
	if (override && override !== spec && !warnedOverride) {
		warnedOverride = true;
		logger.warn(
			{ override, picker: spec },
			"[models] MODEL_ALLOWLIST is set on a Vercel deployment and ignored; config/inference.ts decides the picker"
		);
	}
	return spec;
}

/** First model id in the picker, or undefined if it is empty — the shared primary served model. */
export function primaryModelId(): string | undefined {
	return pickerSpec()
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)[0];
}
