// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { env as publicEnv } from "$env/dynamic/public";
import { env as serverEnv } from "$env/dynamic/private";
import { building } from "$app/env";
import type { Collections } from "./database";
import { Semaphores } from "$lib/chat/types/Semaphore";
import { extraEndpointEnv, openWebUiExtraEndpoints, resolveOpenAiEnv } from "./env/openWebUiAliases";
import { applyOperatorModels } from "./env/operatorModels";
import { committedConfigEnv, isRoleModelKey, roleModelSetting } from "../../../../config/inference";

export type PublicConfigKey = Extract<keyof typeof publicEnv, string>;
const keysFromEnv = { ...publicEnv, ...serverEnv };
applyOperatorModelsFile(keysFromEnv as Record<string, string | undefined>);
applyOpenWebUiNames(keysFromEnv as Record<string, string | undefined>);
export type ConfigKey = Extract<keyof typeof keysFromEnv, string>;

// Open WebUI's OPENAI_API_BASE_URLS / OPENAI_API_KEYS stand in for OPENAI_BASE_URL / OPENAI_API_KEY only
// when OPENAI_BASE_URL is unset, so a deployment that sets it (www does) never reaches the alias path.
// console, not the logger: the logger reads this module's config. Every line is a fixed string or a count.
/* eslint-disable no-console -- the logger imports this module, so these lines cannot use it */
// A self-host's model list file (ALPHA_MODELS_FILE) decides the endpoint, the picker and the role models
// before anything reads them. A bad file throws here, so the server does not start.
function applyOperatorModelsFile(env: Record<string, string | undefined>) {
	const loaded = applyOperatorModels(env);
	if (!loaded) return;
	console.info(
		`[config] model list from ${loaded.path} (ALPHA_MODELS_FILE): ${loaded.env.MODEL_ALLOWLIST.split(",").length} model(s) offered, endpoint ${new URL(loaded.env.OPENAI_BASE_URL).host}`
	);
	if (loaded.replaced.length) {
		console.warn(`[config] ALPHA_MODELS_FILE replaces these settings, which are ignored: ${loaded.replaced.join(", ")}`);
	}
}

function applyOpenWebUiNames(env: Record<string, string | undefined>) {
	const r = resolveOpenAiEnv(env);
	// Read before OPENAI_BASE_URL is set below, which would make the Open WebUI names lose.
	const extras = openWebUiExtraEndpoints(env);
	if (r.source === "open-webui") {
		env.OPENAI_BASE_URL = r.baseUrl;
		// An empty first key is a keyless endpoint; it must not wipe a key that is already set (compose sets "none").
		if (r.apiKey) env.OPENAI_API_KEY = r.apiKey;
		console.info(
			"[config] model endpoint from Open WebUI names (OPENAI_API_BASE_URLS / OPENAI_API_KEYS): OPENAI_BASE_URL is unset"
		);
		if (r.keysGiven !== undefined) {
			console.warn(
				`[config] OPENAI_API_KEYS holds ${r.keysGiven} key(s) for ${r.ignoredEndpoints + 1} URL(s); missing keys are empty and extra keys are dropped, as Open WebUI does`
			);
		}
		// Later endpoints are filed under numbered names for models.ts, which lists each one's models.
		for (const e of extras) {
			const names = extraEndpointEnv(e.n);
			env[names.urlEnv] = e.baseUrl;
			// A keyless endpoint gets "none", as compose gives the first one, so the request still sends a bearer.
			env[names.keyEnv] = e.apiKey || "none";
		}
		if (extras.length) {
			console.info(
				`[config] OPENAI_API_BASE_URLS lists ${extras.length + 1} endpoints; models from all of them are offered`
			);
		}
	} else if (r.openWebUiShadowed) {
		console.info(
			"[config] model endpoint from Alpha's names (OPENAI_BASE_URL); OPENAI_API_BASE_URLS / OPENAI_API_KEYS are ignored"
		);
	}
}
/* eslint-enable no-console -- end of the config-time lines above */

class ConfigManager {
	private keysFromDB: Partial<Record<ConfigKey, string>> = {};
	private isInitialized = false;

	private configCollection: Collections["config"] | undefined;
	private semaphoreCollection: Collections["semaphores"] | undefined;
	private lastConfigUpdate: Date | undefined;

	async init() {
		if (this.isInitialized) return;

		if (building || import.meta.env.MODE === "test") {
			this.isInitialized = true;
			return;
		}

		// When the DB-backed config manager is off (the default), do not touch the database at all —
		// keeps import-time and per-request paths free of DB I/O (serverless posture).
		if (!this.ConfigManagerEnabled) {
			this.isInitialized = true;
			return;
		}

		const { getCollectionsEarly } = await import("./database");
		const collections = await getCollectionsEarly();

		this.configCollection = collections.config;
		this.semaphoreCollection = collections.semaphores;

		await this.checkForUpdates().then(() => {
			this.isInitialized = true;
		});
	}

	get ConfigManagerEnabled() {
		return serverEnv.ENABLE_CONFIG_MANAGER === "true" && import.meta.env.MODE !== "test";
	}

	get isHuggingChat() {
		return this.get("PUBLIC_APP_ASSETS") === "huggingchat";
	}

	async checkForUpdates() {
		if (!this.ConfigManagerEnabled) return;
		if (await this.isConfigStale()) {
			await this.updateConfig();
		}
	}

	async isConfigStale(): Promise<boolean> {
		if (!this.lastConfigUpdate || !this.isInitialized) {
			return true;
		}
		const count = await this.semaphoreCollection?.countDocuments({
			key: Semaphores.CONFIG_UPDATE,
			updatedAt: { $gt: this.lastConfigUpdate },
		});
		return count !== undefined && count > 0;
	}

	async updateConfig() {
		const configs = (await this.configCollection?.find({}).toArray()) ?? [];
		this.keysFromDB = configs.reduce(
			(acc, curr) => {
				acc[curr.key as ConfigKey] = curr.value;
				return acc;
			},
			{} as Record<ConfigKey, string>
		);

		this.lastConfigUpdate = new Date();
	}

	get(key: ConfigKey): string {
		// A role's model is committed config on a deployment. Off Vercel the env var still
		// decides, unset included, since local dev, CI and evals register only the models they name.
		if (isRoleModelKey(key)) {
			if (committedConfigEnv(keysFromEnv)) return roleModelSetting(key);
			return keysFromEnv[key] || "";
		}
		if (!this.ConfigManagerEnabled) {
			return keysFromEnv[key] || "";
		}
		return this.keysFromDB[key] || keysFromEnv[key] || "";
	}

	async updateSemaphore() {
		await this.semaphoreCollection?.updateOne(
			{ key: Semaphores.CONFIG_UPDATE },
			{
				$set: {
					updatedAt: new Date(),
				},
				$setOnInsert: {
					createdAt: new Date(),
				},
			},
			{ upsert: true }
		);
	}

	async set(key: ConfigKey, value: string) {
		if (!this.ConfigManagerEnabled) throw new Error("Config manager is disabled");
		await this.configCollection?.updateOne({ key }, { $set: { value } }, { upsert: true });
		this.keysFromDB[key] = value;
		await this.updateSemaphore();
	}

	async delete(key: ConfigKey) {
		if (!this.ConfigManagerEnabled) throw new Error("Config manager is disabled");
		await this.configCollection?.deleteOne({ key });
		delete this.keysFromDB[key];
		await this.updateSemaphore();
	}

	async clear() {
		if (!this.ConfigManagerEnabled) throw new Error("Config manager is disabled");
		await this.configCollection?.deleteMany({});
		this.keysFromDB = {};
		await this.updateSemaphore();
	}

	getPublicConfig() {
		let config = {
			...Object.fromEntries(
				Object.entries(keysFromEnv).filter(([key]) => key.startsWith("PUBLIC_"))
			),
		} as Record<PublicConfigKey, string>;

		if (this.ConfigManagerEnabled) {
			config = {
				...config,
				...(Object.fromEntries(
					Object.entries(this.keysFromDB).filter(([key]) => key.startsWith("PUBLIC_"))
				) as Record<string, string>),
			};
		}

		const publicEnvKeys = Object.keys(publicEnv);

		return Object.fromEntries(
			Object.entries(config).filter(([key]) => publicEnvKeys.includes(key))
		) as Record<PublicConfigKey, string>;
	}
}

// Create the instance and initialize it.
const configManager = new ConfigManager();

export const ready = (async () => {
	if (!building) {
		await configManager.init();
	}
})();

type ExtraConfigKeys =
	| "HF_TOKEN"
	// Fine-grained HF PAT (repo read+write, current-ai-official/* only) for @huggingface/hub calls
	// against the custodial bucket (custodialBucketRepo.ts). Distinct credential
	// class from HF_TOKEN (inference) — never fall back between them.
	| "HF_BUCKETS_TOKEN"
	// Which bucket custodial storage uses, as buckets/<owner>/<name>. Unset → production's bucket on a
	// production deployment only; anywhere else custodial storage is off (storage/custodialBucketRepo.ts).
	// Preview sets its own so its files and token never touch production's.
	| "HF_BUCKETS_REPO"
	// The master age identities that open owners' key objects in that bucket, as JSON {"<kid>": "AGE-SECRET-KEY-PQ-1..."},
	// and which kid is current. Unset → sealed objects can't be opened.
	| "CUSTODIAL_MASTER_IDENTITIES"
	// The same, held in AWS KMS instead, as JSON {"<kid>": "arn:aws:kms:..."}. A kid in either map can be active.
	| "CUSTODIAL_MASTER_KMS_KEYS"
	// The IAM role a Vercel deployment assumes with its OIDC token to call those keys. Unset → the SDK's default chain.
	| "CUSTODIAL_KMS_ROLE_ARN"
	| "CUSTODIAL_MASTER_ACTIVE"
	// "true" seals every custodial write to its owner's key. A deployment switch, not a flag.
	| "CUSTODIAL_SEAL_WRITES"
	// The server secret for the per-message HMAC-SHA-256 that refuses a forged history, held as
	// key id k0. Rotation: CONVERSATION_HISTORY_MAC_KEYS as JSON {"<kid>": "<hex or base64>"},
	// and CONVERSATION_HISTORY_MAC_KEY_ACTIVE naming the kid new MACs use (sealedTurn.ts macRing).
	| "CONVERSATION_HISTORY_MAC_KEY"
	| "CONVERSATION_HISTORY_MAC_KEYS"
	| "CONVERSATION_HISTORY_MAC_KEY_ACTIVE"
	// Where custodial files live: hf, s3 or local (no default), and each backend's address.
	| "CUSTODIAL_STORAGE_BACKEND"
	| "CUSTODIAL_S3_BUCKET"
	| "CUSTODIAL_S3_ENDPOINT"
	| "CUSTODIAL_S3_REGION"
	| "CUSTODIAL_S3_FORCE_PATH_STYLE"
	| "CUSTODIAL_LOCAL_DIR"
	// The storage OAuth app behind "Connect Hugging Face". Not sign-in's app, never a fallback for it.
	| "HF_STORAGE_OAUTH_CLIENT_ID"
	| "HF_STORAGE_OAUTH_CLIENT_SECRET"
	// HF inference base URL — the backup serving lane for the primary model (same checkpoint, non-
	// sovereign host) when CSCS is the primary OPENAI_BASE_URL. Unset → primary is single-lane.
	| "HF_BASE_URL"
	// Model id the BACKUP lane requests instead of the primary's own id (e.g. "zai-org/GLM-5.2" on the
	// HF router while publicai-direct serves Apertus). Needed when the two hosts don't share an id
	// (a lowercase Apertus id on publicai-direct is not the id the HF router accepts). Unset → the backup lane requests the primary id unchanged (same-checkpoint behavior).
	| "FALLBACK_MODEL_ID"
	// The catalog backup lane's own host and key. Unset → the HF_BASE_URL/HF_TOKEN pair.
	| "FALLBACK_BASE_URL"
	| "FALLBACK_API_KEY"
	| "OLD_MODELS"
	| "ENABLE_ASSISTANTS"
	| "METRICS_ENABLED"
	| "METRICS_PORT"
	// Service-wide daily request cap (cost/abuse guardrail) — enforced in conversation/[id]/+server.
	| "GLOBAL_DAILY_REQUEST_CAP"
	// Firecrawl open-web search auth (POST /v2/search + /v2/scrape, Bearer auth). Required — unlike
	// Wikipedia/OpenAlex/arXiv/Hugging Face, there is no keyless public fallback for this engine.
	// FIRECRAWL_TBS names a time-based search filter applied to open-web searches when set — accepted
	// syntax (docs.firecrawl.dev): predefined ranges `qdr:h|d|w|m|y`,
	// sort-by-date `sbd:1`, combinable e.g. "sbd:1,qdr:w". Unset → no recency bias.
	| "FIRECRAWL_API_KEY"
	| "FIRECRAWL_TBS"
	// Base URL of a self-hosted Firecrawl (same v2 API). Unset → api.firecrawl.dev.
	| "FIRECRAWL_BASE_URL"
	// Base URL of an OpenAI-compatible speech API for read-aloud. Unset → the Hugging Face router.
	| "READ_ALOUD_BASE_URL"
	// Optional bearer for READ_ALOUD_BASE_URL; unset sends no Authorization header.
	| "READ_ALOUD_API_KEY"
	// Model and voice names a custom READ_ALOUD_BASE_URL host expects; unset keeps the Kokoro values.
	| "READ_ALOUD_MODEL"
	| "READ_ALOUD_VOICE"
	// Resend API key for real email-OTP delivery (betterAuth.ts's sendVerificationOTP).
	// Unset → the log-only stub (local dev, or a not-yet-synced environment) instead of a real send.
	| "RESEND_API_KEY"
	// Any SMTP server, as smtp(s)://user:pass@host:port, and the sender it accepts (mailer.ts).
	// Used only when RESEND_API_KEY is unset: a self-hosted Alpha's mail. Unset → no SMTP.
	| "SMTP_URL"
	| "SMTP_FROM"
	// Shared secret for the e2e-only OTP send-cap carve-out (betterAuth.ts's
	// otpSendCapCarveOut). Set ONLY in preview and development env — NEVER production. Unset → the carve-out
	// can never fire regardless of environment or header, which is the safe default.
	| "E2E_OTP_BYPASS_TOKEN"
	// Shared secret for the e2e-only fault-injection switch (textGeneration/faultInjection.ts)
	// — same gating shape as E2E_OTP_BYPASS_TOKEN directly above. Set ONLY in preview and development
	// env — NEVER production. Unset → the switch can never fire regardless of environment or header, which
	// is the safe default.
	| "E2E_FAULT_INJECT_TOKEN"
	// The dedicated model replay database every preview's scenario run shares
	// (endpoints/openai/replayStore.ts). Preview only, NEVER prd.
	| "REPLAY_DATABASE_URL"
	// Human-facing Coop trust & safety dashboard URL, surfaced as a deep-link from /admin/safety.
	// Distinct from COOP_URL (the moderation API base). Unset → the Safety panel shows a note instead.
	| "COOP_DASHBOARD_URL"
	// Default HF Inference Providers route for the primary model. Appended as the `:provider` suffix on
	// the model id when no explicit per-user override is set, so the router stays on a known-warm lane
	// (for Apertus that's "publicai") instead of auto-selecting a cold backend (e.g. featherless) and
	// paying its warmup as TTFT. Unset → router auto-selects (upstream default). See providerPin.ts.
	| "OPENAI_PROVIDER"
	// Warm-leg debounce test seam (warm.ts): when set, REPLACES every leg's throttle window so the spec
	// can pick one large enough that real elapsed time cannot reach it. Config, not a flag — nothing is
	// gated on it and it only widens a debounce. Unset in every deployed config (per-leg defaults stand);
	// a non-numeric or non-positive value falls back to the per-leg default rather than throttling forever.
	| "WARM_THROTTLE_MS"
	// Auto's hosted draft classifier, Clef (clefRoutingGate.ts): router base, key, and model name. Config
	// only; the clef-routing flag is the switch.
	| "CLEF_BASE_URL"
	| "CLEF_API_KEY"
	| "CLEF_MODEL"
	// Shared secret the scheduled production probes send as x-probe-token, so a turn of theirs that a screen
	// declines writes a safety_events row marked as a probe's (probeMarker.ts). Unset → no row is marked.
	| "PROBE_MARKER_TOKEN";

type ConfigProxy = ConfigManager & { [K in ConfigKey | ExtraConfigKeys]: string };

export const config: ConfigProxy = new Proxy(configManager, {
	get(target, prop, receiver) {
		if (prop in target) {
			return Reflect.get(target, prop, receiver);
		}
		if (typeof prop === "string") {
			return target.get(prop as ConfigKey);
		}
		return undefined;
	},
	set(target, prop, value, receiver) {
		if (prop in target) {
			return Reflect.set(target, prop, value, receiver);
		}
		if (typeof prop === "string") {
			void target.set(prop as ConfigKey, value);
			return true;
		}
		return false;
	},
}) as ConfigProxy;
