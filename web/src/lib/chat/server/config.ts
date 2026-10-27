import { env as publicEnv } from "$env/dynamic/public";
import { env as serverEnv } from "$env/dynamic/private";
import { building } from "$app/environment";
import type { Collections } from "./database";
import { Semaphores } from "$lib/chat/types/Semaphore";
import { deployedEnv, isRoleModelKey, roleModelSetting } from "../../../../config/inference";

export type PublicConfigKey = keyof typeof publicEnv;
const keysFromEnv = { ...publicEnv, ...serverEnv };
export type ConfigKey = keyof typeof keysFromEnv;

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
		// A role's model is committed config on a deployment (CUR-2277). Off Vercel the env var still
		// decides, unset included, since local dev, CI and evals register only the models they name.
		if (isRoleModelKey(key)) {
			if (deployedEnv(keysFromEnv)) return roleModelSetting(key);
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
				...Object.fromEntries(
					Object.entries(this.keysFromDB).filter(([key]) => key.startsWith("PUBLIC_"))
				),
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
	// against buckets/current-ai-official/custodial-storage-eu (CUR-899/CUR-412). Distinct credential
	// class from HF_TOKEN (inference) — never fall back between them.
	| "HF_BUCKETS_TOKEN"
	// Which bucket custodial storage uses, as buckets/<owner>/<name>. Unset → the production bucket.
	// Preview sets its own so its files and token never touch production's (CUR-1288).
	| "HF_BUCKETS_REPO"
	// The master age identities that open owners' key objects in that bucket, as JSON {"<kid>": "AGE-SECRET-KEY-PQ-1..."},
	// and which kid is current (CUR-4115, docs/plans/custodial-file-encryption.md). Unset → sealed objects can't be opened.
	| "CUSTODIAL_MASTER_IDENTITIES"
	// The same, held in AWS KMS instead, as JSON {"<kid>": "arn:aws:kms:..."} (CUR-4136). A kid in either map can be active.
	| "CUSTODIAL_MASTER_KMS_KEYS"
	// The IAM role a Vercel deployment assumes with its OIDC token to call those keys (CUR-4269). Unset → the SDK's default chain.
	| "CUSTODIAL_KMS_ROLE_ARN"
	| "CUSTODIAL_MASTER_ACTIVE"
	// "true" seals every custodial write to its owner's key (CUR-4116). A deployment switch, not a flag.
	| "CUSTODIAL_SEAL_WRITES"
	// The storage OAuth app behind "Connect Hugging Face" (CUR-2932). Not sign-in's app, never a fallback for it.
	| "HF_STORAGE_OAUTH_CLIENT_ID"
	| "HF_STORAGE_OAUTH_CLIENT_SECRET"
	// HF inference base URL — the backup serving lane for the primary model (same checkpoint, non-
	// sovereign host) when CSCS is the primary OPENAI_BASE_URL. Unset → primary is single-lane.
	| "HF_BASE_URL"
	// Model id the BACKUP lane requests instead of the primary's own id (e.g. "zai-org/GLM-5.2" on the
	// HF router while publicai-direct serves Apertus). Needed when the two hosts don't share an id
	// (a lowercase Apertus id on publicai-direct is not the id the HF router accepts). Unset → the backup lane requests the primary id unchanged (same-checkpoint behavior).
	| "FALLBACK_MODEL_ID"
	// The catalog backup lane's own host and key (CUR-2293). Unset → the HF_BASE_URL/HF_TOKEN pair.
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
	// Resend API key for real email-OTP delivery (CUR-518, betterAuth.ts's sendVerificationOTP).
	// Unset → the log-only stub (local dev, or a not-yet-synced environment) instead of a real send.
	| "RESEND_API_KEY"
	// Shared secret for the e2e-only OTP send-cap carve-out (CUR-1553, betterAuth.ts's
	// otpSendCapCarveOut). Set ONLY in Doppler's preview/dev configs — NEVER prd. Unset → the carve-out
	// can never fire regardless of environment or header, which is the safe default.
	| "E2E_OTP_BYPASS_TOKEN"
	// Shared secret for the e2e-only fault-injection switch (CUR-1614, textGeneration/faultInjection.ts)
	// — same gating shape as E2E_OTP_BYPASS_TOKEN directly above. Set ONLY in Doppler's preview/dev
	// configs — NEVER prd. Unset → the switch can never fire regardless of environment or header, which
	// is the safe default.
	| "E2E_FAULT_INJECT_TOKEN"
	// The dedicated model replay database every preview's scenario run shares
	// (endpoints/openai/replayStore.ts). Preview only, NEVER prd. (SOL-148)
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
	| "CLEF_MODEL";

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
