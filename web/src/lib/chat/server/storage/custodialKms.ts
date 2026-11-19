// The two AWS KMS calls behind the custodial master, Encrypt and Decrypt.
// KMS encrypts the owner's age identity directly (it is far under Encrypt's 4 KB limit), so the KMS
// key never leaves AWS and every unwrap is a CloudTrail event. The owner is bound in as encryption
// context, so a key object copied onto another owner's path is refused by KMS itself.
//
// On Vercel, `CUSTODIAL_KMS_ROLE_ARN` names the role this deployment assumes with its own OIDC token,
// so no AWS secret sits in env; the role's trust policy decides which environment may.
// Everywhere else credentials come from the AWS SDK's default chain: a task or instance role on AWS,
// AWS_ROLE_ARN with a web-identity token file, an AWS_PROFILE whose role_arn the SDK assumes, or
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Off Vercel the role ARN is ignored, since there is no Vercel
// OIDC token to assume it with; an operator who wants a role names it the SDK's way.

import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";

const clients = new Map<string, KMSClient>();

/** With the SDK's defaults a stalled STS or KMS call holds a person's first upload for as
 *  long as the socket stays open, retried three times. Each call here gets this long, twice. */
const KMS_CALL_LIMITS = {
	maxAttempts: 2,
	requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 },
};

/** The region a key ARN lives in: `arn:aws:kms:<region>:<account>:key/<id>` or `…:alias/<name>`. */
export function kmsRegion(keyArn: string): string | null {
	const parts = keyArn.split(":");
	return parts.length >= 6 && parts[0] === "arn" && parts[2] === "kms" && parts[3] ? parts[3] : null;
}

let warnedRoleIgnored = false;

/** The role to assume with Vercel's OIDC token: `CUSTODIAL_KMS_ROLE_ARN`, on Vercel only. Off Vercel
 *  there is no token to assume it with, so the SDK's default chain signs instead. */
function vercelOidcRole(): string | undefined {
	const roleArn = config.CUSTODIAL_KMS_ROLE_ARN || undefined;
	if (!roleArn || process.env.VERCEL) return roleArn;
	if (!warnedRoleIgnored) {
		warnedRoleIgnored = true;
		logger.warn(
			{ event: "custodial-kms-role-ignored" },
			"[custodial-kms] CUSTODIAL_KMS_ROLE_ARN is set off Vercel, where it cannot be assumed; using the AWS SDK default credential chain"
		);
	}
	return undefined;
}

function client(keyArn: string): KMSClient {
	const region = kmsRegion(keyArn);
	if (!region) throw new Error(`not a KMS key ARN: ${keyArn}`);
	const roleArn = vercelOidcRole();
	const cacheKey = `${region} ${roleArn ?? ""}`;
	let c = clients.get(cacheKey);
	if (!c) {
		c = new KMSClient(
			roleArn
				? { region, ...KMS_CALL_LIMITS, credentials: awsCredentialsProvider({ roleArn, clientConfig: { region, ...KMS_CALL_LIMITS } }) }
				: { region, ...KMS_CALL_LIMITS }
		);
		clients.set(cacheKey, c);
	}
	return c;
}

export async function kmsEncrypt(keyArn: string, plaintext: Uint8Array, context: Record<string, string>): Promise<Uint8Array> {
	const out = await client(keyArn).send(new EncryptCommand({ KeyId: keyArn, Plaintext: plaintext, EncryptionContext: context }));
	if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
	return out.CiphertextBlob;
}

/** Decrypt with this key only. KMS throws `InvalidCiphertextException` when the blob was made under
 *  another key or another owner's context, or was altered. */
export async function kmsDecrypt(keyArn: string, ciphertext: Uint8Array, context: Record<string, string>): Promise<Uint8Array> {
	const out = await client(keyArn).send(new DecryptCommand({ KeyId: keyArn, CiphertextBlob: ciphertext, EncryptionContext: context }));
	if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
	return out.Plaintext;
}
