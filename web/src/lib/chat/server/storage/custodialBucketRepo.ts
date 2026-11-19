// Which Hugging Face bucket custodial storage uses on this deployment, and whether it has one at all.
//
// `HF_BUCKETS_REPO` names it. Unset, only a production deployment (DEPLOY_ENV, or VERCEL_ENV, says
// production) gets production's bucket. Everywhere else (preview,
// local dev, CI, a self-host, a deployment that declares no environment) unset means there is no
// bucket: the storage surface is off, account deletion and export report "no storage", and any
// direct storage call throws CustodialBucketUnsetError (custodialStorage.ts) rather than read and
// write production's files under whatever token the deployment holds.
import { config } from "$lib/chat/server/config";
import { deployEnv } from "$lib/chat/server/deployEnv";
import { logger } from "$lib/chat/server/logger";

/** Production's bucket, in Hugging Face's EU region, and the one a production deployment gets
 *  when `HF_BUCKETS_REPO` is unset. */
export const PRODUCTION_CUSTODIAL_BUCKET_REPO = "buckets/current-ai-official/custodial-storage-eu";

let warnedUnset = false;

/**
 * The configured `HF_BUCKETS_REPO` (trimmed, shape not checked here), production's bucket on a
 * production deployment with it unset, or `null` when this deployment has no bucket. The first `null`
 * logs an error, once per process, naming the variable.
 */
export function resolvedCustodialBucketRepo(): string | null {
	const configured = config.HF_BUCKETS_REPO?.trim();
	if (configured) return configured;
	const env = deployEnv();
	if (env === "production") return PRODUCTION_CUSTODIAL_BUCKET_REPO;
	if (!warnedUnset) {
		warnedUnset = true;
		logger.error(
			{ deployEnv: env ?? null },
			`[custodial-storage] HF_BUCKETS_REPO is not set on this ${env ?? "undeclared"} deployment, so custodial storage is unavailable: ` +
				`only production uses ${PRODUCTION_CUSTODIAL_BUCKET_REPO} by default. Set HF_BUCKETS_REPO (and HF_BUCKETS_TOKEN) to turn it on.`
		);
	}
	return null;
}

/** Whether this deployment has a bucket to store into: `HF_BUCKETS_REPO` set, or production. */
export function custodialBucketRepoConfigured(): boolean {
	return resolvedCustodialBucketRepo() !== null;
}
